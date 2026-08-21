"""Verify RSA key loading: all env formats + file fallback + broken-env fall-through."""
import base64
import os
import subprocess
import sys
import tempfile

from Crypto.PublicKey import RSA

key = RSA.generate(2048)
pem = key.export_key().decode()  # multi-line PEM string

SCRIPT = r"""
import base64, os, server
assert server.server_rsa_key.has_private()
print("LOADED-OK")
"""

def run(env_value, label):
    with tempfile.TemporaryDirectory() as td:
        env = os.environ.copy()
        env["RSA_PRIVATE_KEY"] = env_value
        env["OPERATOR_TOKEN"] = "t"
        env["PYTHONPATH"] = os.path.dirname(os.path.abspath(__file__))
        # keep the temp dir CWD so a stray generated pem doesn't pollute the repo
        r = subprocess.run([sys.executable, "-c", SCRIPT], input=None,
                           capture_output=True, text=True, env=env, cwd=td, timeout=60)
        out = r.stdout + r.stderr
        ok = "LOADED-OK" in out and "Traceback" not in out
        print(f"{label}: {'PASS' if ok else 'FAIL'}")
        if not ok:
            print(out[-800:])
        return ok

results = []
results.append(run(base64.b64encode(pem.encode()).decode(), "base64(PEM)          "))
results.append(run(pem.replace("\n", "\\n"), "raw PEM w/ \\n escapes"))
results.append(run(pem, "multi-line raw PEM    "))
results.append(run("not-a-real-key!!!", "broken value -> file/gen fallback"))

# broken env var must fall through to an existing pem FILE (stable restarts)
with tempfile.TemporaryDirectory() as td:
    with open(os.path.join(td, "server_rsa.pem"), "wb") as f:
        f.write(key.export_key())
    env = os.environ.copy()
    env["RSA_PRIVATE_KEY"] = "garbage-value"
    env["OPERATOR_TOKEN"] = "t"
    env["PYTHONPATH"] = os.path.dirname(os.path.abspath(__file__))
    script = SCRIPT + "\nimport base64\n"
    r = subprocess.run([sys.executable, "-c", SCRIPT], capture_output=True, text=True,
                       env=env, cwd=td, timeout=60)
    out = r.stdout + r.stderr
    ok = "LOADED-OK" in out and "server_rsa.pem" in out
    print(f"broken env -> pem file : {'PASS' if ok else 'FAIL'}")
    results.append(ok)
    if not ok:
        print(out[-800:])

print("ALL RSA LOADER TESTS PASSED" if all(results) else "SOME TESTS FAILED")
