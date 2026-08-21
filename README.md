<p align="center">
<img src="assets/banner.png" alt="AeroCommand — Remote Access Trojan Framework" width="100%">
</p>
<p align="center">
  <strong>Python and Tauri-based Remote Access Trojan (RAT) with C2 server, encrypted communications, and evasion techniques.</strong>
</p>
<p align="center">
  <em>For authorized penetration testing and red team operations only.</em>
</p>

---

## Table of Contents

1. [Overview](#overview)
2. [Key Capabilities](#key-capabilities)
3. [System Architecture](#system-architecture)
4. [Repository Structure](#repository-structure)
5. [Prerequisites & Environment Setup](#prerequisites--environment-setup)
6. [Operator Guide & Deployment](#operator-guide--deployment)
   - [Running the Management Server](#1-running-the-management-server)
   - [Launching the Tauri Operator Dashboard](#2-launching-the-tauri-operator-dashboard)
   - [Deploying and Configuring the Endpoint Client](#3-deploying-and-configuring-the-endpoint-client)
   - [Building Standalone Executables](#4-building-standalone-executables)
7. [Command Reference](#command-reference)
8. [Communication Protocol & Security Model](#communication-protocol--security-model)
9. [Troubleshooting & FAQ](#troubleshooting--faq)
10. [Disclaimer & Compliance](#disclaimer--compliance)

---

## Overview

**AeroCommand** is a fully-featured Remote Access Trojan (RAT) designed for authorized penetration testing and red team operations. It consists of:

- **C2 Server** (`server.py`): Flask-based command and control server with SQLite logging
- **Windows Client** (`client.py`): Endpoint agent with persistence, evasion, and remote execution capabilities
- **Operator Dashboard** (`aerocommand-tauri/`): Modern Tauri v2 + React desktop GUI for remote management
- **Alternative GUI** (`control_panel.py`): Lightweight Python CustomTkinter control panel

**Core Features:**
- Hybrid RSA-2048 + AES-256-GCM encrypted communications
- Anti-VM/sandbox detection and anti-debug evasion
- Windows Defender disabling and persistence mechanisms
- Remote command execution, file exfiltration, and clipboard monitoring
- Screenshot capture and process management

> **⚠️ LEGAL DISCLAIMER:** This software is for authorized security testing only. Unauthorized access to computer systems is illegal. Users assume all responsibility for compliance with applicable laws.

---

## Key Capabilities

| Category | Features |
| --- | --- |
| **Evasion & Stealth** | Anti-VM/sandbox detection, anti-debug checks, console window hiding, randomized user-agents, jittered polling intervals |
| **Persistence** | Startup folder copy + Registry Run key (dual persistence), survives system reboots |
| **Defense Evasion** | Windows Defender real-time protection disabling, registry policy modifications |
| **Remote Execution** | Arbitrary shell command execution, built-in commands (sysinfo, ps, screenshot, etc.) |
| **Data Exfiltration** | File download/upload, clipboard monitoring, screenshot capture |
| **File System** | Directory browsing with `os.scandir()`, instant image/text previews, OneDrive path resolution |
| **Process Management** | Process listing with details, process termination by PID/name |
| **C2 Communications** | Hybrid RSA-2048 + AES-256-GCM encryption, session key exchange, no plaintext fallback |
| **Operator Interface** | Tauri v2 + React dashboard, real-time telemetry, interactive terminal, SQLite logging |

---

## System Architecture

```
┌─────────────────────────────────────────┐       HTTP Polling / JSON       ┌──────────────────────────┐
│         AeroCommand C2 Server           │  ◄────────────────────────────► │     Windows Client       │
│       Tauri v2 GUI / server.py          │         (AES-256-GCM)           │        client.py         │
│                                         │                                 │                          │
│  • Command Queuing & Dispatch           │                                 │  • Anti-VM Detection     │
│  • SQLite Session & Logging             │                                 │  • Defender Bypass       │
│  • Encrypted Communications             │                                 │  • Persistence Mechanisms│
│  • Real-time Telemetry Dashboard        │                                 │  • Remote Execution      │
│  • File Explorer & Previews             │                                 │  • Clipboard Monitoring  │
│  • Process Manager                      │                                 │  • Screenshot Capture    │
└─────────────────────────────────────────┘                                 └──────────────────────────┘
```

---

## Repository Structure

```
.
├── aerocommand-tauri/        # Tauri v2 + React operator dashboard
│   ├── src/                  # React frontend (terminal, file explorer, previews)
│   └── src-tauri/            # Rust backend (DB handlers, native bridge)
├── assets/                   # Graphical assets and banners
├── build/                    # Build artifacts
├── dist/                     # Compiled PyInstaller executables (e.g., WindowsUpdate.exe)
├── loot/                     # Exfiltrated files organized by hostname
├── venv/                     # Python virtual environment
├── client.py                 # Windows RAT agent with evasion capabilities
├── WindowsUpdate.spec        # PyInstaller payload build (onefile, windowed)
├── client.spec               # PyInstaller debug build (onedir, console)
├── control_panel.py          # Alternative CustomTkinter GUI
├── server.py                 # Flask C2 server with encrypted communications
├── requirements.txt          # Python dependencies
├── aerocommand.db            # SQLite database for session/command logging
└── README.md                 # This documentation
```

---

## Prerequisites & Environment Setup

### System Requirements

| Requirement | Supported Environment / Version |
| --- | --- |
| **Python** | Python 3.10 or newer (with `pip`) |
| **Node.js & Package Manager** | Node.js 18+ with `pnpm` (required for Tauri frontend) |
| **Rust Toolchain** | Stable Rust toolchain (`rustc`, `cargo`) for building Tauri v2 backend |
| **Endpoint Client OS** | Windows 10 or Windows 11 test systems |
| **Management Server OS** | Windows or Linux laboratory host |

### Installation Steps

1. **Clone or Navigate to the Repository:**
   Ensure you are in the project root directory.

2. **Install Python Dependencies:**
   ```powershell
   pip install -r requirements.txt
   ```

3. **Install Tauri Frontend Dependencies:**
   ```powershell
   cd aerocommand-tauri
   pnpm install
   cd ..
   ```

4. **Configure Environment Variables:**
   Copy `.env.example` to `.env` and set your secrets:
   ```powershell
   cp .env.example .env
   ```
   Then edit `.env` and set:
   ```env
   C2_DOMAIN=http://127.0.0.1:443/
   PORT=443
   OPERATOR_TOKEN=your-secret-operator-token-here
   ```
   > **Important:** Choose a strong random token for `OPERATOR_TOKEN`. This token authenticates the operator dashboard to the server's API endpoints.

---

## Operator Guide & Deployment

### 1. Running the Management Server
Start the Flask management server to handle endpoint registrations, command queuing, and result logging:
```powershell
python server.py
```
By default, the server initializes an SQLite database (`aerocommand.db`) and listens for incoming agent check-ins.

### 2. Launching the Tauri Operator Dashboard
To run the modern desktop control panel in development mode:
```powershell
cd aerocommand-tauri
pnpm tauri dev
```
The Tauri application launches the operator interface, providing real-time telemetry, terminal access, and file management.

### 3. Deploying and Configuring the Endpoint Client
Before running or compiling `client.py`, set the C2 address via the `C2_DOMAIN` variable — either in a `.env` file next to the client or in the environment:
```powershell
# .env (resolved relative to the client's working directory)
C2_DOMAIN=http://127.0.0.1:443/      # Laboratory server address
```
Other knobs (`POLLING_DELAY`, `JITTER`, `ANTI_VM`, ...) live in the configuration block at the top of `client.py`.

Run the endpoint agent on the test Windows system:
```powershell
python client.py
```

### 4. Building Standalone Executables
To compile the payload executable with PyInstaller:
```powershell
pyinstaller .\WindowsUpdate.spec --noconfirm
```
The compiled executable will be generated at:
```
./dist/WindowsUpdate.exe
```

> **Why two spec files?** `WindowsUpdate.spec` is the deployable payload: a **onefile**, windowed executable. This matters because persistence (`add_persistence()`) copies *only* the exe itself into the Startup folder — an onefile build is self-contained and survives the copy. `client.spec` produces an **onedir** console build (`dist/client/client.exe` + `_internal\` folder), useful only for local debugging; its bare exe will not run if copied elsewhere.

> **Note:** the client resolves `C2_DOMAIN` from a `.env` file in its working directory, falling back to `http://127.0.0.1:443`. When launching `dist\WindowsUpdate.exe` from `dist\`, drop a `.env` beside it to target a different server (e.g., your Render URL).

---

## Command Reference

The C2 server supports remote command execution on compromised endpoints:

### Remote Execution

| Command | Description |
| --- | --- |
| `sysinfo` | Gather system information (hostname, OS, user, admin status, network) |
| `ps` | List running processes with PID, memory, CPU, and window titles |
| `killproc <pid/name>` | Terminate a process by PID or name |
| `screenshot` | Capture screen and upload to C2 server |
| `cd <path>` | Change working directory on remote endpoint |
| `pwd` | Display current working directory |
| `ls [path]` | List directory contents with file details |
| `download <path>` | Exfiltrate file from target to C2 server |
| `upload <url> <dst>` | Download file from URL to target system |

### Data Collection

| Command | Description |
| --- | --- |
| `clip` | Read current clipboard contents |
| `clipwatch` | Start real-time clipboard monitoring (logs changes to C2) |
| `clipstop` | Stop clipboard monitoring |
| `preview <path>` | Preview images or text files from target system |

### Persistence & Evasion

| Command | Description |
| --- | --- |
| `persist` | Re-apply persistence (Startup folder + Registry Run key) |
| `sleep <seconds>` | Adjust polling interval (1-3600 seconds) |
| `dialog <title> \| <msg>` | Display Windows message box on target |
| `kill` | Self-destruct client (remove persistence + delete executable) |

---

## Communication Protocol & Security Model

AeroCommand uses HTTP/HTTPS with hybrid RSA-2048 + AES-256-GCM encryption for all C2 communications:

### Encryption Implementation
- **Key Exchange:** Client fetches RSA-2048 public key, generates AES-256 session key, wraps with RSA-OAEP
- **Data Protection:** All traffic encrypted with AES-256-GCM (nonce + tag + ciphertext, Base64 encoded)
- **No Fallback:** Every endpoint rejects plaintext bodies; decryption failures return `None` — the channel cannot degrade to plaintext
- **Session Recovery:** If the server restarts and loses session keys, `/cmd` answers `401` (empty body) and the client re-runs the hybrid handshake

### C2 Endpoints

| Route | Method | Purpose |
| --- | --- | --- |
| `/rsa_pub` | GET | Server RSA-2048 public key for key exchange |
| `/register` | POST | Client registration with hybrid RSA+AES encryption |
| `/cmd` | GET | Command polling (AES encrypted responses) |
| `/result` | POST | Result delivery (AES encrypted payloads) |
| `/upload` | POST | File exfiltration to C2 server |

### Operator API (Bearer Token Auth)

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/clients` | GET | List registered endpoints |
| `/api/logs` | GET | Retrieve command history |
| `/api/send_command` | POST | Queue commands for targets |
| `/api/loot` | GET | List exfiltrated artifacts |

---

## Troubleshooting

### Common Issues

1. **Tauri Build Errors:**
   - Missing Rust toolchain or WebView2 runtime
   - Install Visual Studio C++ build tools

2. **Client Connection Refused:**
   - `C2_DOMAIN` mismatch or server not running
   - Verify server is active on correct port

3. **Defender Detection:**
   - Expected behavior — RAT executables are flagged
   - Add exclusion in Windows Defender for testing environments

---

## Disclaimer & Legal Warning

> **⚠️ FOR AUTHORIZED PENETRATION TESTING ONLY**
> 
> AeroCommand is a Remote Access Trojan (RAT) designed for:
> - Authorized penetration testing engagements
> - Red team operations with written authorization
> - Security research in isolated lab environments
> 
> **LEGAL REQUIREMENTS:**
> - You MUST have explicit written authorization before using this software
> - Unauthorized access to computer systems is illegal under CFAA, CMA, and similar laws
> - This software is provided "as is" without warranty
> - Users assume all legal responsibility for their actions
> 
> **PROHIBITED USES:**
> - Unauthorized access to any computer system
> - Accessing systems without explicit permission
> - Any activity violating local, national, or international laws
> 
> The developers assume no liability for misuse or damage caused by this software.
