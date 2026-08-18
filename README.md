<p align="center">
<img src="assets/banner.png" alt="AeroCommand — Remote Endpoint Monitoring and Security Telemetry" width="100%">
</p> <p align="center">
  <strong>Lightweight Python client-server framework for authorized endpoint monitoring, administration, and security telemetry testing.</strong>
</p> <p align="center">
  <em>Designed for isolated labs, controlled demonstrations, and approved security research.</em>
</p>

---

## Overview

**AeroCommand** is a lightweight Python client-server framework for studying endpoint monitoring workflows and security telemetry in controlled environments. It provides a management server, a Windows-focused endpoint client, session tracking, command queuing, diagnostic collection, and artifact handling for authorized lab testing.

The project is intended for **defensive research, system administration exercises, and isolated security simulations**. It must not be used to access, monitor, control, or collect data from systems without explicit permission.

> **Important:** Run this project only on systems you own or are expressly authorized to test. Do not expose the server to the public internet or deploy the client on third-party devices.

## Capabilities

| Area | Functionality |
| --- | --- |
| Endpoint monitoring | Collects approved system diagnostics, process context, network information, screenshots, directory listings, and clipboard state during authorized testing. |
| Session management | Tracks registered endpoints, active status, process identifiers, and selected target context. |
| Command delivery | Queues operator-approved actions through the management server and records returned results. |
| Artifact handling | Stores test outputs and collected artifacts under the local `loot/` directory. |
| Communication | Uses HTTP polling with configurable delay and jitter for lab simulations. |
| Persistence research | Includes optional startup-configuration checks for controlled Windows lab experiments. |
| Storage | Maintains client registration history and command logs in SQLite. |

## Architecture

AeroCommand consists of two primary components:

| Component | File | Responsibility |
| --- | --- | --- |
| Management server | `server.py` | Hosts the HTTP service, manages sessions, queues commands, monitors endpoint health, and stores test artifacts. |
| Endpoint client | `client.py` | Polls the server, performs approved diagnostic actions, and returns encrypted test responses. |

```
┌──────────────────────────┐       HTTP polling / JSON       ┌──────────────────────────┐
│                          │  ◄──────────────────────────►  │                          │
│    Management Server     │                                │     Windows Endpoint     │
│       server.py          │                                │        client.py         │
│                          │                                │                          │
│  • Sessions              │                                │  • Diagnostics           │
│  • Command queue        │                                │  • Approved actions      │
│  • Health monitoring     │                                │  • Result delivery       │
│  • SQLite logs           │                                │  • Optional lab checks   │
└──────────────────────────┘                                └──────────────────────────┘
```

## Quick Start

### Prerequisites

| Requirement | Supported environment |
| --- | --- |
| Python | 3.10 or newer |
| Endpoint client | Windows test systems |
| Management server | Windows or Linux laboratory host |
| Network | Private, isolated, or explicitly authorized test network |

### Install dependencies

```
pip install -r requirements.txt
```

### Start the management server

```
python server.py
```

The default configuration listens on `0.0.0.0:443` over HTTP. For laboratory use, restrict access with host firewall rules and bind to a private interface whenever possible.

## Client Configuration

Update the endpoint client configuration before starting an authorized test:

```python
# client.py
C2_DOMAIN = "http://127.0.0.1:443/"  # Laboratory server address
POLLING_DELAY = 5                     # Polling frequency in seconds
JITTER = 2                            # Random delay range in seconds
ANTI_VM = False                       # Optional controlled-lab sandbox check
```

> **Security note:** The default transport is HTTP and the project uses single-byte XOR obfuscation for payload testing. These mechanisms are not a substitute for production-grade TLS, authenticated encryption, certificate validation, or secure key management.

## Build the Windows Client

Compile a standalone Windows client with PyInstaller:

```
pyinstaller .\client.spec
```

The generated executable is written to:

```
./dist/WindowsUpdate.exe
```

Use a neutral test filename and a dedicated laboratory directory when demonstrating the project. Do not disguise test software as a system component on real endpoints.

## Command Reference

The server CLI becomes available after the management server starts. Use the following commands only against explicitly authorized laboratory endpoints.

### Session Management

| Command | Description |
| --- | --- |
| `list` | Displays registered clients, status, IP address, and process identifier. |
| `target <id>` | Selects the active client context. |
| `broadcast <cmd>` | Queues an approved command for all connected clients. |

### Endpoint Diagnostics and Interaction

| Command | Description |
| --- | --- |
| `sysinfo` | Retrieves approved hardware, OS, user, network-interface, and privilege diagnostics. |
| `screenshot` | Captures the endpoint display and stores the result under `./loot/<hostname>/`. |
| `pwd` | Returns the current working directory. |
| `cd <path>` | Changes the current working directory. |
| `ls [path]` | Lists files with type, size, and modification time. |
| `download <path>` | Copies an explicitly selected test artifact to the server’s `./loot/` directory. |
| `upload <url> <dst>` | Instructs the client to retrieve a test file from an approved laboratory URL. |
| `sleep <seconds>` | Changes the client polling interval. |
| `dialog <title> | <msg>` | Displays a visible Windows message box for demonstration purposes. |
| `persist` | Verifies or reapplies the configured startup behavior in a controlled lab. |

### Clipboard Testing

| Command | Description |
| --- | --- |
| `clip` | Reads the current clipboard text during an approved test. |
| `clipwatch` | Starts a background clipboard-change monitor with a three-second interval. |
| `clipstop` | Stops the active clipboard monitor. |

### Server Utilities

| Command | Description |
| --- | --- |
| `kill` | Requests client self-termination and a clean exit. |
| `db clients` | Displays historical client registration records from SQLite. |
| `db logs [limit]` | Queries recent command results from SQLite. |
| `help` | Displays the available command list and usage information. |
| `clear` | Clears the local terminal screen. |
| `exit` | Shuts down the management server process. |

## Communication Model

The current test protocol uses the following HTTP routes:

| Route | Purpose |
| --- | --- |
| `POST /register` | Registers an endpoint with the management server. |
| `GET /cmd` | Retrieves queued instructions. |
| `POST /result` | Returns command output and diagnostic results. |
| `POST /upload` | Transfers an approved test artifact. |

Payloads are JSON data encoded over raw HTTP request bodies. The current implementation applies byte-level XOR obfuscation with a configurable single-byte key, then Base64 encoding. This behavior is suitable for telemetry and detection experiments, but it should be treated as **intentionally non-production**.

## Recommended Lab Controls

Use a private virtual network, disposable virtual machines, non-sensitive test data, and dedicated test accounts. Keep endpoint and server logs enabled, document authorization before each exercise, and remove generated artifacts after testing. For any real deployment or enterprise integration, replace the current transport and payload protection with authenticated TLS and a properly designed cryptographic protocol.

## Project Layout

```
.
├── server.py             # Management server
├── client.py             # Windows endpoint client
├── client.spec           # PyInstaller build configuration
├── requirements.txt      # Python dependencies
├── loot/                 # Local test artifacts and outputs
└── README.md             # Project documentation
```

## Disclaimer

> **FOR EDUCATIONAL AND AUTHORIZED SECURITY RESEARCH / LAB TESTING ONLY.**AeroCommand is intended solely for authorized system administration, security auditing, and educational simulations in isolated laboratory environments. Unauthorized access to computer systems, interception of data, persistence on devices, or collection of information is illegal under applicable local, national, and international laws. The maintainers are not responsible for misuse or damage caused by this software.

## License

Add the project license and contribution guidelines here before publishing the repository. If this is an internal research project, state the permitted audience and distribution restrictions explicitly.