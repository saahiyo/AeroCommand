<p align="center">
<img src="assets/banner.png" alt="AeroCommand — Remote Endpoint Monitoring and Security Telemetry" width="100%">
</p> <p align="center">
  <strong>Lightweight Python and Tauri C2 & endpoint administration framework for authorized monitoring, security telemetry testing, and lab demonstrations.</strong>
</p> <p align="center">
  <em>Designed for isolated labs, controlled demonstrations, and approved security research.</em>
</p>

---

## Overview

**AeroCommand** is a modern client-server framework for studying endpoint administration workflows, command execution pipelines, and security telemetry in controlled environments. It provides a robust Rust/Python management backend, a sleek modern **Tauri v2 + React** desktop dashboard, a Python CustomTkinter control panel, and a Windows-focused endpoint client with live diagnostic streaming and high-performance file exploring.

The project is intended for **defensive research, system administration exercises, and isolated security simulations**. It must not be used to access, monitor, control, or collect data from systems without explicit permission.

> **Important:** Run this project only on systems you own or are expressly authorized to test. Do not expose the server to the public internet or deploy the client on third-party devices.

## Capabilities

| Area | Functionality |
| --- | --- |
| **Desktop Admin Dashboard** | Modern Tauri v2 + React 19 + Tailwind interface with dark glassmorphism, real-time client status, telemetry charts, interactive terminal, and process manager. |
| **Remote File Explorer** | High-performance directory navigation powered by `os.scandir()` and structured JSON serialization with clickable breadcrumbs, navigation history, and quick access folders. |
| **Instant Live Previews** | In-modal previewing of remote images (PNG, JPG, ICO, WebP) with zoom controls and transparency support, plus UTF-8 text/script viewer. |
| **OneDrive & Shell Resolution** | Dynamic Windows Registry querying (`User Shell Folders`) that automatically resolves paths for folders redirected to OneDrive (Desktop, Documents, Pictures, etc.). |
| **Telemetry & Diagnostics** | Real-time CPU, RAM, Network, and Disk usage metrics along with system information, process listing, and process termination. |
| **Command Delivery** | Interactive terminal queuing with real-time polling, result delivery, and SQLite execution history. |
| **Artifact Collection** | One-click artifact downloads and loot gallery under `./loot/<hostname>/`. |
| **Clipboard Stream** | Real-time clipboard monitoring with automatic logging to the management server. |

## Architecture

AeroCommand consists of modular backend and operator interfaces:

| Component | Path / File | Responsibility |
| --- | --- | --- |
| **Tauri Desktop App** | `aerocommand-tauri/` | Modern Rust + React desktop GUI with live client metrics, terminal, process manager, and remote file explorer. |
| **Management Server** | `server.py` | Standalone Flask-based management server with SQLite session & command logging. |
| **CustomTkinter GUI** | `control_panel.py` | Lightweight Python desktop GUI for operator management and loot visualization. |
| **Endpoint Client** | `client.py` | Polling client supporting diagnostics, instant previews, file browsing, persistence checks, and command execution. |

```
┌─────────────────────────────────────────┐       HTTP Polling / JSON       ┌──────────────────────────┐
│         AeroCommand Control Panel       │  ◄────────────────────────────► │     Windows Endpoint     │
│       Tauri v2 GUI / server.py          │                                 │        client.py         │
│                                         │                                 │                          │
│  • Real-time Telemetry Dashboard        │                                 │  • System Diagnostics    │
│  • Remote File Explorer & Previews      │                                 │  • Live File Previews    │
│  • Interactive Command Terminal         │                                 │  • Process Telemetry     │
│  • Process Manager & Termination        │                                 │  • Result Delivery       │
│  • Loot Gallery & SQLite Logs           │                                 │  • Shell Resolution      │
└─────────────────────────────────────────┘                                 └──────────────────────────┘
```

## Quick Start

### Prerequisites

| Requirement | Supported environment |
| --- | --- |
| Python | 3.10 or newer |
| Node.js / Rust | Node.js 18+ (pnpm) and Rust (for Tauri desktop app) |
| Endpoint client | Windows 10/11 test systems |
| Management server | Windows or Linux laboratory host |

### 1. Install Dependencies

```powershell
# Python environment
pip install -r requirements.txt

# Tauri frontend
cd aerocommand-tauri
pnpm install
cd ..
```

### 2. Run the Tauri Desktop Control Panel

```powershell
cd aerocommand-tauri
pnpm tauri dev
```

The Tauri application will launch the built-in Rust C2 listener on port `443` and open the operator desktop interface.

### 3. Start the Python Endpoint Client

```powershell
python client.py
```

## Client Configuration

Update the endpoint client configuration in `client.py` before testing:

```python
# client.py
C2_DOMAIN = "http://127.0.0.1:443/"  # Laboratory server address
POLLING_DELAY = 5                     # Polling frequency in seconds
JITTER = 2                            # Random delay range in seconds
ANTI_VM = False                       # Set to False for local testing/VMs
```

> **Security note:** The default transport is HTTP with byte-level XOR obfuscation and Base64 encoding. These mechanisms are designed for controlled telemetry testing and detection research, not production environments.

## Build Standalone Executable

Compile a standalone Windows client using PyInstaller:

```powershell
pyinstaller .\client.spec --noconfirm
```

The generated executable is output to:

```
./dist/WindowsUpdate.exe
```

## Command Reference

The command center and interactive terminal support the following commands:

### Session & Diagnostics

| Command | Description |
| --- | --- |
| `sysinfo` | Retrieves hardware specs, OS version, active user, network info, and admin rights. |
| `ps` | Lists running processes with PID, memory, CPU, and window titles in structured JSON. |
| `killproc <pid/name>` | Terminates a target process on the remote endpoint. |
| `screenshot` | Captures the remote screen and saves the image to `./loot/<hostname>/`. |
| `pwd` | Returns the current working directory. |
| `cd <path>` | Changes the current working directory. |

### File Exploration & Previews

| Command | Description |
| --- | --- |
| `ls [path]` | Fast directory listing returning structured JSON (`[JSON_FILES]`) with type, size, and modified date. |
| `preview <path>` | Streams an instant preview of images (PNG, JPG, ICO, WebP) or text files to the preview modal. |
| `download <path>` | Downloads a remote file and saves it into the local loot store. |
| `upload <url> <dst>` | Instructs the remote client to download a file from an approved URL to destination. |

### Utilities & Telemetry

| Command | Description |
| --- | --- |
| `clip` | Reads the current clipboard text. |
| `clipwatch` | Starts real-time clipboard monitoring and logs changes to the server. |
| `clipstop` | Stops clipboard monitoring. |
| `sleep <seconds>` | Adjusts the client polling interval (1–3600 seconds). |
| `dialog <title> \| <msg>` | Displays a native Windows alert message box on the client. |
| `persist` | Verifies or sets startup persistence in the user Startup folder. |
| `kill` | Commands the client to self-destruct and exit cleanly. |

## Communication Model

The HTTP communication endpoints:

| Route | Method | Purpose |
| --- | --- | --- |
| `/register` | `POST` | Initial endpoint handshake and system telemetry payload. |
| `/cmd` | `GET` | Polling endpoint for retrieving queued instructions. |
| `/result` | `POST` | Delivering execution output, telemetry, and structured data. |
| `/upload` | `POST` | Streaming binary artifacts and downloaded loot to the server. |

## Project Layout

```
.
├── aerocommand-tauri/        # Tauri v2 + React 19 operator desktop application
│   ├── src/                  # React dashboard, terminal, file explorer, preview modal
│   └── src-tauri/            # Rust C2 backend, DB handlers, and native bridge
├── client.py                 # Windows endpoint agent (diagnostics, scandir, previews)
├── client.spec               # PyInstaller standalone build specification
├── control_panel.py          # Alternative CustomTkinter Python desktop GUI
├── server.py                 # Standalone Flask-based C2 management server
├── requirements.txt          # Python dependencies (Pillow, requests, etc.)
├── loot/                     # Downloaded files, screenshots, and collected artifacts
├── aerocommand.db            # SQLite history and client records
└── README.md                 # Project documentation
```

## Disclaimer

> **FOR EDUCATIONAL AND AUTHORIZED SECURITY RESEARCH / LAB TESTING ONLY.** AeroCommand is intended solely for authorized system administration, security auditing, and educational simulations in isolated laboratory environments. Unauthorized access to computer systems, interception of data, persistence on devices, or collection of information is illegal under applicable local, national, and international laws. The maintainers are not responsible for misuse or damage caused by this software.