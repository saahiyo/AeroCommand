"""Verify format_console_payload renders each structured payload type."""
import os

os.environ.setdefault("OPERATOR_TOKEN", "test-operator-token-123456")
import server

F = lambda s: server.format_console_payload(s)

# FILES
files = F('[JSON_FILES]{"path": "C:\\\\Users\\\\Shakir\\\\Downloads\\\\bca semwise result", "items": ['
          '{"name": "sem 1-6 result.zip", "size": "631.9 KB", "date": "2026-08-17 12:16", "is_dir": false},'
          '{"name": "subdir", "size": "", "date": "2026-08-13 12:58", "is_dir": true},'
          '{"name": "sem 1.pdf", "size": "140.2 KB", "date": "2026-08-13 12:58", "is_dir": false}], '
          '"count": 3, "truncated": false}')
assert "Directory:" in files and "<DIR>" in files and "sem 1.pdf" in files and "[JSON" not in files, files

# PROCS
procs = F('[JSON_PROCS][{"name":"explorer.exe","pid":"1234","mem":"65,120 K","user":"Shakir","cpu":"0:01:02","title":"File Explorer"},'
          '{"name":"svchost.exe","pid":"888","mem":"12,345 K","user":"SYSTEM","cpu":"","title":""}]')
assert "Running processes: 2" in procs and "explorer.exe" in procs and "1234" in procs, procs

# APPS (with error branch)
apps = F('[JSON_APPS]{"items": [{"name":"Android Studio","version":"2025.3","publisher":"Google LLC","size":"","date":""},'
         '{"name":"aria2","version":"1.37.0","publisher":"aria2","size":"","date":""}], "count": 2}')
assert "Installed applications: 2" in apps and "Google LLC" in apps and apps.index("Android Studio") < apps.index("aria2"), apps
apps_err = F('[JSON_APPS]{"items": [], "count": 0, "error": "boom"}')
assert "boom" in apps_err

# ICONS — base64 values must NOT appear
icons = F('[JSON_ICONS]{"icons": {"a": "AAAAbase64blob", "b": "BBBB"}}')
assert "App icons extracted: 2" in icons and "AAAAbase64blob" not in icons, icons

# PREVIEW ok — data/content must NOT appear
prev = F('[JSON_PREVIEW]{"status":"ok","type":"image","name":"shot.png","mime":"image/png","data":"iVBORw0KGgoAAA"}')
assert "Preview OK (image" in prev and "iVBOR" not in prev, prev
prev_text = F('[JSON_PREVIEW]{"status":"ok","type":"text","name":"notes.txt","content":"SECRETTEXT","size":"2 KB"}')
assert "notes.txt" in prev_text and "SECRETTEXT" not in prev_text, prev_text
prev_err = F('[JSON_PREVIEW]{"status":"error","message":"File not found: x"}')
assert "not found" in prev_err

# Plain output passes through untouched
plain = F("C:\\Users\\tester")
assert plain == "C:\\Users\\tester"

# Malformed JSON falls back to raw
bad = F('[JSON_FILES]{broken')
assert bad.startswith("[JSON_FILES]")

print("ALL FORMATTER TESTS PASSED")
