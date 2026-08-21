"""Live test of client.py's keylogger on this machine (hook + synthetic keystrokes)."""
import sys
import time

sys.argv = ["client.py"]
import importlib.util
spec = importlib.util.spec_from_file_location("client_mod", "client.py")
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)  # __main__ guard prevents auto-start

ct = client.ctypes
u32 = ct.windll.user32

# 1. Start
r1 = client.start_keylogger()
print("start:", r1)
assert "started" in r1
time.sleep(0.5)

# 2. Synthesize typing: "hi" then ENTER (keybd_event goes through the LL hook)
def key(vk, up=False):
    u32.keybd_event(vk, 0, 2 if up else 0, 0)

for vk in (0x48, 0x49):                       # H, I
    key(vk); time.sleep(0.03); key(vk, True); time.sleep(0.05)
key(0x0D); time.sleep(0.03); key(0x0D, True)  # ENTER
time.sleep(0.3)

# 3. Dump — buffer should contain hi + newline
dump1 = client.dump_keystrokes()
print("dump1:", repr(dump1))
assert "KEYLOG DUMP" in dump1 and "hi" in dump1 and "\n" in dump1, dump1

# 4. Dump again — cleared after first dump; still running
dump2 = client.dump_keystrokes()
print("dump2:", repr(dump2))
assert "No keystrokes captured" in dump2 and "running" in dump2

# 5. Stop retains buffer semantics: type more, stop, dump must still return it
for vk in (0x58,):                            # X
    key(vk); time.sleep(0.03); key(vk, True)
time.sleep(0.2)
r2 = client.stop_keylogger(clear_buffer=False)
print("stop:", r2)
dump3 = client.dump_keystrokes()
print("dump3:", repr(dump3))
assert "x" in dump3.lower(), dump3

# 6. Restart clears previous buffer
r3 = client.start_keylogger()
time.sleep(0.3)
dump4 = client.dump_keystrokes()
assert "No keystrokes" in dump4, dump4
client.stop_keylogger(clear_buffer=True)

print("ALL KEYLOGGER TESTS PASSED")
