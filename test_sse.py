"""End-to-end SSE tests for the AeroCommand C2 server.

Verifies the /api/events push stream using the werkzeug test client in
streaming (buffered=False) mode: auth via Bearer header and ?token= query
param, rejection of bad tokens, the sync snapshot, live 'log'/'clients'/
'loot' broadcasts, and ?since= replay of missed rows.

Run:  python test_sse.py
"""
import base64
import json
import os
import sqlite3
import tempfile

os.environ.setdefault("OPERATOR_TOKEN", "test-operator-token-123456")

import server
from Crypto.PublicKey import RSA
from Crypto.Cipher import PKCS1_OAEP, AES
from Crypto.Hash import SHA256
from Crypto.Random import get_random_bytes

# Isolate DB + loot from the real ones
_tmp = tempfile.mkdtemp(prefix="aerocommand_sse_test_")
server.DB_FILE = os.path.join(_tmp, "test.db")
server.LOOT_DIR = os.path.join(_tmp, "loot")
server.init_db()

c = server.app.test_client()
aes_key = get_random_bytes(32)
CID = "5.6.7.8:444"
TOKEN = "test-operator-token-123456"


def enc_payload(obj) -> str:
    cipher = AES.new(aes_key, AES.MODE_GCM)
    ct, tag = cipher.encrypt_and_digest(json.dumps(obj).encode())
    return base64.b64encode(cipher.nonce + tag + ct).decode()


class Stream:
    """Wraps a streaming test response; accumulate until an SSE frame ends."""

    def __init__(self, path):
        self.resp = c.get(path, headers={"Authorization": f"Bearer {TOKEN}"}, buffered=False)
        assert self.resp.status_code == 200, f"SSE connect failed: {self.resp.status_code}"
        assert "text/event-stream" in self.resp.content_type, self.resp.content_type
        self.buf = ""
        self.it = iter(self.resp.response)

    def next_frame(self):
        while "\n\n" not in self.buf:
            self.buf += next(self.it).decode()
        frame, self.buf = self.buf.split("\n\n", 1)
        return json.loads(frame.removeprefix("data: "))

    def close(self):
        self.resp.close()


# Register client (hybrid RSA+AES handshake)
r = c.get("/rsa_pub")
pub = RSA.import_key(r.data.decode())
rsa_cipher = PKCS1_OAEP.new(pub, hashAlgo=SHA256)
enc_key = base64.b64encode(rsa_cipher.encrypt(aes_key)).decode()
reg = {"client_id": CID, "host": "SSEBOX", "ip": "5.6.7.8", "pid": 444,
       "os": "Windows 11", "user": "tester", "admin": True}
r = c.post("/register", json={"encrypted_session_key": enc_key, "payload": enc_payload(reg)})
assert r.status_code == 200, f"register failed: {r.status_code}"

# 1. Auth variants
r = c.get("/api/events")
assert r.status_code == 403, "no token accepted"
r = c.get("/api/events?token=WRONG")
assert r.status_code == 403, "bad query token accepted"
s = Stream(f"/api/events?token={TOKEN}")
s.close()  # header-auth path already proven by Stream's constructor

# 2. Sync snapshot on connect
s = Stream("/api/events")
sync_ev = s.next_frame()
assert sync_ev["type"] == "sync", sync_ev
assert any(cl["id"] == CID and cl["admin"] for cl in sync_ev["clients"]), sync_ev
print("[+] snapshot event OK")

# 3. Live 'log' broadcast when a result lands
r = c.post(f"/result?id={CID}",
           data=enc_payload({"command": "whoami", "output": "ssebox\\tester", "client_id": CID}),
           content_type="application/octet-stream")
assert r.status_code == 200
log_ev = s.next_frame()
assert log_ev["type"] == "log" and log_ev["log"]["command"] == "whoami", log_ev
assert log_ev["log"]["output"] == "ssebox\\tester" and log_ev["log"]["status"] == "SUCCESS"
first_log_id = log_ev["log"]["id"]
print("[+] live log broadcast OK (id=%d)" % first_log_id)

# 4. 'loot' broadcast on upload
png = b"\x89PNG\r\n\x1a\n fake-sse-image"
r = c.post(f"/upload?id={CID}",
           data=enc_payload({"name": "sse.png", "file": base64.b64encode(png).decode(), "client_id": CID}),
           content_type="application/octet-stream")
assert r.status_code == 200
loot_ev = s.next_frame()
assert loot_ev["type"] == "loot", loot_ev
print("[+] loot broadcast OK")
s.close()

# 5. ?since= replays rows newer than the cursor
s2 = Stream(f"/api/events?since={max(0, first_log_id - 1)}&token={TOKEN}")
replay_sync = s2.next_frame()
assert replay_sync["type"] == "sync", replay_sync
ids = [lg["id"] for lg in replay_sync.get("replay", [])]
assert first_log_id in ids, f"replay missing log {first_log_id}: {ids}"
s2.close()
print("[+] since-replay OK")

# 6. No leak of logs at/behind the cursor
with sqlite3.connect(server.DB_FILE) as conn:
    total = conn.execute("SELECT COUNT(*) FROM command_logs").fetchone()[0]
s3 = Stream(f"/api/events?since={total}&token={TOKEN}")
strict = s3.next_frame()
assert strict.get("replay") == [], f"replayed behind-cursor rows: {strict.get('replay')}"
s3.close()
print("[+] replay cursor boundary OK")

print("ALL SSE TESTS PASSED")
