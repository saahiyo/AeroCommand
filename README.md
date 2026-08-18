# AeroCommand

A lightweight client-server framework built in Python for remote endpoint monitoring, administration, and security telemetry testing.

---

## ⚠️ Disclaimer

> **FOR EDUCATIONAL AND AUTHORIZED SECURITY RESEARCH / LAB TESTING ONLY.**  
> This software is intended solely for authorized system administration, security auditing, and educational simulations in isolated lab environments. Unauthorized access to computer systems is illegal under applicable local, national, and international laws.

---

## 📐 Architecture Overview

The framework consists of two primary components:

1. **C2 Server (`server.py`)**:
   - Built on Flask, running background daemon threads for CLI interaction and client health monitoring.
   - Manages connected sessions, command queues, and exfiltrated artifacts (`loot/` directory).
   - Handles payload decryption and encrypted responses.

2. **Endpoint Client (`client.py`)**:
   - HTTP polling client with configurable jitter to query server instructions.
   - Gathers system diagnostics, screen captures, directory structures, and clipboard state.
   - Built-in session deduplication via Windows named mutex and lockfile.

```
+-------------------+        HTTP (Encrypted Payload)       +--------------------+
|                   | <===================================> |                    |
|     C2 Server     |       POST /register, GET /cmd        |   Endpoint Client  |
|    (server.py)    |       POST /result, POST /upload      |    (client.py)     |
|                   |                                       |                    |
+-------------------+                                       +--------------------+
```

---

## 🚀 Getting Started

### Prerequisites

- **Python**: 3.10+
- **OS**: Windows (Client target), Windows/Linux (Server host)

### Dependencies

Install required Python dependencies:

```powershell
pip install -r requirements.txt
```

---

## 🛠️ Configuration & Setup

### 1. Server Setup

Start the listening server:

```powershell
python server.py
```

By default, the server listens on `0.0.0.0:443` (HTTP).

### 2. Client Configuration

Configure the C2 address in `client.py`:

```python
# client.py
C2_DOMAIN = "http://127.0.0.1:443/"  # Target server IP/Domain
POLLING_DELAY = 5                     # Polling frequency (seconds)
JITTER = 2                            # Jitter range (+/- seconds)
ANTI_VM = False                       # Set to True for sandbox checks
```

### 3. Building Client Executable

Compile the standalone Windows client using PyInstaller:

```powershell
pyinstaller .\client.spec
```

The resulting binary will be output to `./dist/WindowsUpdate.exe`.

---

## 🕹️ Command Reference

Once the server CLI interface is active (`💀 RAT >`), the following commands are available:

### Session Management

| Command | Description |
|---|---|
| `list` | Displays all registered clients, status (`ALIVE`/`DEAD`), IP, and PID |
| `target <id>` | Switches active context to a specific client index |
| `broadcast <cmd>` | Queues a command for all currently connected clients |

### Client Interaction

| Command | Description |
|---|---|
| `sysinfo` | Retrieves system hardware, OS version, user, network interfaces, and privileges |
| `screenshot` | Captures screen state and saves output to `./loot/<hostname>/` |
| `pwd` | Returns current working directory on target |
| `cd <path>` | Changes working directory on target |
| `ls [path]` | Formatted file listing showing type, size, and modified timestamp |
| `download <path>` | Exfiltrates specified file from client to `./loot/` |
| `upload <url> <dst>` | Instructs client to download remote file to local destination |
| `sleep <seconds>` | Modifies client polling interval dynamically |
| `dialog <title> \| <msg>` | Displays a native Windows message box |
| `persist` | Verifies and reapplies startup configuration |

### Clipboard Operations

| Command | Description |
|---|---|
| `clip` | Reads current clipboard text content |
| `clipwatch` | Starts a background thread checking for clipboard updates every 3s |
| `clipstop` | Terminates active clipboard monitor thread |

### Danger Zone & Server Utilities

| Command | Description |
|---|---|
| `kill` | Initiates self-termination and clean exit on client |
| `help` | Displays command list and usage |
| `clear` | Clears local terminal screen |
| `exit` | Shuts down C2 server process |

---

## 🔒 Communication Protocol

Payloads sent over HTTP endpoints (`/register`, `/cmd`, `/result`, `/upload`) utilize byte-level XOR obfuscation encoded in Base64:

- **Key**: Configurable single-byte XOR key (`0x5A`)
- **Format**: JSON payloads encoded over raw HTTP body streams
