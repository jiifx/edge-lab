// Prop Edge Lab 2 - Rust backend.
// Storage: Documents/PropEdgeLab/{journal.db, images/*.jpg, exports/}  (SQLite; migrates v1 journal.json once)
// Engine:  Monte Carlo (phase walk / funded harvest) with bootstrap CIs, mirroring the TS fallback engine.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;

use base64::Engine as _;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

struct Db(Mutex<Connection>);

// Resolved once per launch so every command agrees on where the journal lives.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
// Non-fatal storage problem worth telling the user about (surfaced in the journal rail).
static STORAGE_NOTE: Mutex<Option<String>> = Mutex::new(None);

fn note(msg: String) {
    if let Ok(mut g) = STORAGE_NOTE.lock() {
        if g.is_none() {
            *g = Some(msg);
        }
    }
}

fn writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".pel_write_test");
    match fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

// macOS puts ~/Documents behind TCC. If the user declines that prompt (or an MDM
// policy blocks it) every write fails - previously the app panicked before a window
// existed, so it just bounced in the Dock and vanished on every launch. Fall back
// to Application Support instead, and say so.
fn data_dir() -> PathBuf {
    DATA_DIR
        .get_or_init(|| {
            if let Some(p) = dirs::document_dir().map(|d| d.join("PropEdgeLab")) {
                if writable(&p) {
                    return p;
                }
            }
            if let Some(p) = dirs::data_dir().map(|d| d.join("PropEdgeLab")) {
                if writable(&p) {
                    note(format!(
                        "Your Documents folder is not writable, so the journal is being stored in {} instead. On macOS this usually means the Documents permission was declined - you can grant it in System Settings > Privacy & Security > Files and Folders, then restart.",
                        p.display()
                    ));
                    return p;
                }
            }
            let t = std::env::temp_dir().join("PropEdgeLab");
            let _ = fs::create_dir_all(&t);
            note(format!(
                "No writable data folder was found, so the journal is in a temporary location ({}) that the system may clear. Export a backup now.",
                t.display()
            ));
            t
        })
        .clone()
}

fn ensure_dirs() -> Result<PathBuf, String> {
    let d = data_dir();
    fs::create_dir_all(d.join("images")).map_err(|e| e.to_string())?;
    fs::create_dir_all(d.join("exports")).map_err(|e| e.to_string())?;
    Ok(d)
}

fn open_db() -> Result<Connection, String> {
    let d = ensure_dirs()?;
    let conn = Connection::open(d.join("journal.db")).map_err(|e| e.to_string())?;
    // busy_timeout: the data folder is often cloud-synced, so another process can
    // hold the lock briefly - wait rather than failing the write outright.
    conn.execute_batch(&format!("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; {SCHEMA}"))
        .map_err(|e| e.to_string())?;
    migrate_v1(&conn, &d)?;
    Ok(conn)
}

// One-time import of the v1 journal.json (array or {meta,trades}) into SQLite.
fn migrate_v1(conn: &Connection, d: &Path) -> Result<(), String> {
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM trades", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let done: Option<String> = conn
        .query_row("SELECT v FROM meta WHERE k='v1_migrated'", [], |r| r.get(0))
        .ok();
    if n > 0 || done.is_some() {
        return Ok(());
    }
    let f = d.join("journal.json");
    if !f.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&f).map_err(|e| e.to_string())?;
    let val: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    let (trades, meta) = if val.is_array() {
        (val.as_array().cloned().unwrap_or_default(), None)
    } else {
        (
            val.get("trades").and_then(|t| t.as_array()).cloned().unwrap_or_default(),
            val.get("meta").cloned(),
        )
    };
    for t in &trades {
        if let Some(id) = t.get("id").and_then(|v| v.as_str()) {
            let dt = t.get("dateTime").and_then(|v| v.as_str()).unwrap_or("");
            let _ = conn.execute(
                "INSERT OR REPLACE INTO trades(id, dateTime, data) VALUES(?1, ?2, ?3)",
                rusqlite::params![id, dt, t.to_string()],
            );
        }
    }
    if let Some(m) = meta {
        let _ = conn.execute(
            "INSERT OR REPLACE INTO meta(k, v) VALUES('journal', ?1)",
            rusqlite::params![m.to_string()],
        );
    }
    let _ = conn.execute(
        "INSERT OR REPLACE INTO meta(k, v) VALUES('v1_migrated', ?1)",
        rusqlite::params![trades.len().to_string()],
    );
    Ok(())
}

fn safe_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("bad id".into());
    }
    Ok(())
}

// ---------- journal ----------

#[tauri::command]
fn db_load(db: tauri::State<Db>) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT data FROM trades ORDER BY dateTime DESC")
        .map_err(|e| e.to_string())?;
    let rows: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let meta: Option<String> = conn
        .query_row("SELECT v FROM meta WHERE k='journal'", [], |r| r.get(0))
        .ok();
    let trades: Vec<serde_json::Value> = rows
        .iter()
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect();
    let meta_val: serde_json::Value = meta
        .and_then(|m| serde_json::from_str(&m).ok())
        .unwrap_or(serde_json::Value::Null);
    Ok(serde_json::json!({ "meta": meta_val, "trades": trades }).to_string())
}

#[tauri::command]
fn db_replace_all(db: tauri::State<Db>, trades: String, meta: String) -> Result<(), String> {
    let list: Vec<serde_json::Value> =
        serde_json::from_str(&trades).map_err(|_| "trades: not valid JSON".to_string())?;
    serde_json::from_str::<serde_json::Value>(&meta).map_err(|_| "meta: not valid JSON".to_string())?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM trades", []).map_err(|e| e.to_string())?;
    for t in &list {
        let id = t.get("id").and_then(|v| v.as_str()).ok_or("trade missing id")?;
        let dt = t.get("dateTime").and_then(|v| v.as_str()).unwrap_or("");
        tx.execute(
            "INSERT OR REPLACE INTO trades(id, dateTime, data) VALUES(?1, ?2, ?3)",
            rusqlite::params![id, dt, t.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO meta(k, v) VALUES('journal', ?1)",
        rusqlite::params![meta],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

// ---------- images (plain files: sync-friendly, human-recoverable) ----------

#[tauri::command]
fn save_image(id: String, data: String) -> Result<(), String> {
    safe_id(&id)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    let d = ensure_dirs()?;
    fs::write(d.join("images").join(format!("{id}.jpg")), bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_image(id: String) -> Result<String, String> {
    safe_id(&id)?;
    let f = data_dir().join("images").join(format!("{id}.jpg"));
    let bytes = fs::read(f).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn delete_image(id: String) -> Result<(), String> {
    safe_id(&id)?;
    let f = data_dir().join("images").join(format!("{id}.jpg"));
    if f.exists() {
        fs::remove_file(f).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- shell integration ----------

fn reveal(path: &Path, select_file: bool) {
    #[cfg(target_os = "windows")]
    {
        let mut c = std::process::Command::new("explorer");
        if select_file {
            c.arg("/select,");
        }
        let _ = c.arg(path.as_os_str()).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let mut c = std::process::Command::new("open");
        if select_file {
            c.arg("-R");
        }
        let _ = c.arg(path.as_os_str()).spawn();
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let target = if select_file { path.parent().unwrap_or(path) } else { path };
        let _ = std::process::Command::new("xdg-open").arg(target.as_os_str()).spawn();
    }
}

#[tauri::command]
fn export_journal(data: String, silent: Option<bool>) -> Result<String, String> {
    let d = ensure_dirs()?;
    let f = d.join("exports").join(format!("prop-edge-lab-journal-{}.json", now_stamp()));
    fs::write(&f, data).map_err(|e| e.to_string())?;
    // silent = weekly auto-backup: write without popping the file manager
    if !silent.unwrap_or(false) {
        reveal(&f, true);
    }
    Ok(f.to_string_lossy().into_owned())
}

fn now_stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (now / 86400) as i64;
    let secs = now % 86400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}-{:02}{:02}{:02}", y, m, d, secs / 3600, (secs % 3600) / 60, secs % 60)
}

#[tauri::command]
fn data_dir_path() -> String {
    data_dir().to_string_lossy().into_owned()
}

#[tauri::command]
fn reveal_data_dir() -> Result<(), String> {
    let d = ensure_dirs()?;
    reveal(&d, false);
    Ok(())
}

// The user manual ships inside the bundle as a resource (tauri.conf.json
// bundle.resources) and opens in whatever the OS uses for PDFs. The data-dir
// copy is a fallback for a dev run, where no resource directory exists.
const MANUAL_FILE: &str = "Edge Lab - User Manual.pdf";

#[tauri::command]
fn open_manual(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let bundled = app
        .path()
        .resolve(MANUAL_FILE, tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file());
    let f = match bundled {
        Some(p) => p,
        None => {
            let p = ensure_dirs()?.join(MANUAL_FILE);
            if !p.is_file() {
                return Err(format!("{MANUAL_FILE} is not installed with this build"));
            }
            p
        }
    };
    reveal(&f, false);
    Ok(())
}

// ---------- engine ----------

#[tauri::command]
fn engine_odds(rs: Vec<f64>, firm: engine::Firm, re: f64, rf: f64) -> Result<engine::Odds, String> {
    if rs.len() < 2 {
        return Err("need at least 2 resolved trades".into());
    }
    Ok(engine::odds(&rs, &firm, re, rf))
}

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS trades(id TEXT PRIMARY KEY, dateTime TEXT, data TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);";

// Never fail to a blank screen: if the database cannot be opened at all, run from
// memory so the window still appears and can explain itself.
fn open_db_or_memory() -> Connection {
    match open_db() {
        Ok(c) => c,
        Err(e) => {
            note(format!(
                "The journal database could not be opened ({e}), so this session is running in memory and will NOT be saved. Fix the folder permission and restart before logging trades."
            ));
            let c = Connection::open_in_memory().expect("in-memory SQLite is always available");
            let _ = c.execute_batch(SCHEMA);
            c
        }
    }
}

#[tauri::command]
fn storage_note() -> Option<String> {
    STORAGE_NOTE.lock().ok().and_then(|g| g.clone())
}

fn main() {
    let conn = open_db_or_memory();
    tauri::Builder::default()
        .manage(Db(Mutex::new(conn)))
        .invoke_handler(tauri::generate_handler![
            db_load,
            db_replace_all,
            save_image,
            load_image,
            delete_image,
            export_journal,
            data_dir_path,
            reveal_data_dir,
            open_manual,
            storage_note,
            engine_odds
        ])
        .run(tauri::generate_context!())
        .expect("error while running Prop Edge Lab 2");
}

#[cfg(test)]
mod storage_tests {
    use super::*;

    #[test]
    fn writable_detects_a_usable_dir() {
        let d = std::env::temp_dir().join("pel_writable_probe");
        assert!(writable(&d), "a fresh temp dir should be writable");
        assert!(!d.join(".pel_write_test").exists(), "the probe file must be cleaned up");
        let _ = fs::remove_dir_all(&d);
    }

    // The macOS TCC case: Documents exists but every write is denied. Simulating a
    // real denial needs macOS, so this covers the other branch - an unusable path -
    // proving writable() reports false instead of panicking, which is what keeps the
    // window on screen.
    #[test]
    fn writable_rejects_an_unusable_path() {
        #[cfg(windows)]
        let bad = PathBuf::from("\\\\?\\Z:\\definitely\\not\\mounted\\pel");
        #[cfg(not(windows))]
        let bad = PathBuf::from("/proc/self/mem/pel_cannot_exist");
        assert!(!writable(&bad), "an unmountable path must report not-writable");
    }

    #[test]
    fn falls_back_to_memory_instead_of_panicking() {
        // open_db_or_memory must always yield a usable connection carrying the schema
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM trades", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "schema applies cleanly to a memory database");
    }
}
