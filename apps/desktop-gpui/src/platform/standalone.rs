//! A Mac of its own: an app built with the core inside it (`Contents/Resources/Switch Host.app`,
//! scripts/release.sh) runs that core here, under this user's ~/.switch, as a LaunchAgent
//! (ax.switch.core), with no server, ssh or tailnet. At every launch the core it carries is put in
//! when it isn't the one installed: on first launch, and after each update of the app, which so
//! updates the core too. Before a swap the core is stopped and the brain copied aside; a core that
//! won't serve within a minute is put back.
//!
//! It only ever touches a ~/.switch it made (`~/.switch/standalone`): a Mac already set up another
//! way (a core elsewhere, a deploy's own) is left as it is. A build without a core inside does
//! nothing here.

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::helpers::{bundle, home, write_atomic};

const LABEL: &str = "ax.switch.core";
/// The core's port when it's free; the next free one after it otherwise.
const PORT: u16 = 4871;
const HOST_APP: &str = "Switch Host.app";

fn dir() -> PathBuf {
    std::env::var("SWITCH_DIR").map(PathBuf::from).unwrap_or_else(|_| home().join(".switch"))
}

/// The core this app carries, when it carries one.
pub fn carried() -> Option<PathBuf> {
    let core = bundle()?.join("Contents/Resources").join(HOST_APP);
    core.join("Contents/MacOS/switch").exists().then_some(core)
}

fn installed() -> PathBuf {
    dir().join("app").join(HOST_APP)
}

fn mark() -> PathBuf {
    dir().join("standalone")
}

/// This Mac's core is the one this app installs: it has one, and ~/.switch is (or will be) its own.
pub fn ours() -> bool {
    carried().is_some() && (mark().exists() || !dir().join("brain.db").exists() && !dir().join("config.json").exists())
}

fn version(app: &Path) -> String {
    let out = Command::new("/usr/bin/plutil").args(["-extract", "CFBundleVersion", "raw", "-o", "-"]).arg(app.join("Contents/Info.plist")).output();
    out.ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

fn uid() -> u32 {
    unsafe extern "C" {
        fn getuid() -> u32;
    }
    // SAFETY: getuid has no preconditions.
    unsafe { getuid() }
}

fn launchctl(args: &[&str]) -> bool {
    Command::new("/bin/launchctl").args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

/// The login session's domain; the user's background one when there's none (a run over ssh).
fn domain() -> String {
    let gui = format!("gui/{}", uid());
    if launchctl(&["print", &gui]) { gui } else { format!("user/{}", uid()) }
}

fn loaded() -> bool {
    launchctl(&["print", &format!("{}/{LABEL}", domain())])
}

fn plist() -> PathBuf {
    home().join("Library/LaunchAgents").join(format!("{LABEL}.plist"))
}

fn xml(v: &str) -> String {
    v.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn write_unit() -> std::io::Result<()> {
    let logs = home().join("Library/Logs/switch");
    std::fs::create_dir_all(&logs)?;
    let exe = installed().join("Contents/MacOS/switch");
    let path = format!("{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", home().display());
    let log = logs.join("core.log");
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{LABEL}</string>\n<key>ProgramArguments</key><array><string>{}</string></array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>{}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Interactive</string>\n<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>16384</integer></dict>\n<key>ExitTimeOut</key><integer>30</integer>\n<key>StandardOutPath</key><string>{}</string>\n<key>StandardErrorPath</key><string>{}</string>\n</dict></plist>\n",
        xml(&exe.to_string_lossy()),
        xml(&path),
        xml(&log.to_string_lossy()),
        xml(&log.to_string_lossy()),
    );
    write_atomic(&plist(), body.as_bytes(), Some(0o644))
}

fn stop() {
    launchctl(&["bootout", &format!("{}/{LABEL}", domain())]);
    let until = Instant::now() + Duration::from_secs(40);
    while loaded() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// The core loaded into launchd, or what launchctl said when it wasn't.
fn start() -> Result<(), String> {
    launchctl(&["enable", &format!("{}/{LABEL}", domain())]);
    let mut said = String::new();
    for _ in 0..5 {
        let out = Command::new("/bin/launchctl").args(["bootstrap", &domain(), &plist().to_string_lossy()]).stdout(Stdio::null()).output().map_err(|e| e.to_string())?;
        said = String::from_utf8_lossy(&out.stderr).trim().to_string();
        std::thread::sleep(Duration::from_secs(1));
        if loaded() {
            return Ok(());
        }
    }
    Err(format!("launchd didn't take the core ({said})"))
}

/// Nothing listens on `port`, and it can be had.
fn free(port: u16) -> bool {
    let at = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&at, Duration::from_millis(300)).is_err() && std::net::TcpListener::bind(at).is_ok()
}

/// The core's port, as its config names it.
fn port() -> u16 {
    std::fs::read_to_string(dir().join("config.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).and_then(|v| v.get("port").and_then(serde_json::Value::as_u64)).and_then(|p| u16::try_from(p).ok()).unwrap_or(PORT)
}

/// The core answers on its port within `secs`.
fn serving(secs: u64) -> bool {
    let at = SocketAddr::from(([127, 0, 0, 1], port()));
    let until = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < until {
        if TcpStream::connect_timeout(&at, Duration::from_secs(1)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

fn ditto(from: &Path, to: &Path) -> bool {
    Command::new("/usr/bin/ditto").arg(from).arg(to).status().is_ok_and(|s| s.success())
}

/// The brain, copied aside before another core opens it: the last three kept.
fn back_up() {
    let brain = dir().join("brain.db");
    if !brain.exists() {
        return;
    }
    let backups = dir().join("backups");
    let _ = std::fs::create_dir_all(&backups);
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    for ext in ["", "-wal"] {
        let from = dir().join(format!("brain.db{ext}"));
        if from.exists() {
            let _ = Command::new("/bin/cp").arg("-c").arg(&from).arg(backups.join(format!("{stamp}-update.db{ext}"))).status();
        }
    }
    let mut kept: Vec<_> = std::fs::read_dir(&backups).into_iter().flatten().flatten().map(|d| d.path()).filter(|p| p.to_string_lossy().ends_with("-update.db")).collect();
    kept.sort();
    let drop = kept.len().saturating_sub(3);
    for old in kept.into_iter().take(drop) {
        let _ = std::fs::remove_file(&old);
        let _ = std::fs::remove_file(format!("{}-wal", old.display()));
    }
}

/// Puts the carried core in when it isn't the one installed, and makes sure it runs. Answers what
/// went wrong, if anything. Blocks: run it off the main thread.
pub fn ensure() -> Result<(), String> {
    let Some(core) = carried() else { return Ok(()) };
    if !ours() {
        return Ok(());
    }
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    if !mark().exists() {
        write_atomic(&mark(), b"", None).map_err(|e| e.to_string())?;
    }
    // The only machine: turns, and what runs on an always-on machine or beside the browser, run
    // here. Its port, the first free from 4871, and where the app finds it.
    let config = dir().join("config.json");
    if !config.exists() {
        let port = (PORT..PORT + 30).find(|p| free(*p)).ok_or("No free port for the core")?;
        let body = format!("{{\n  \"port\": {port},\n  \"core\": \"http://127.0.0.1:{port}\",\n  \"provides\": [\"always-on\", \"browser\"]\n}}\n");
        write_atomic(&config, body.as_bytes(), Some(0o600)).map_err(|e| e.to_string())?;
    }
    let live = installed();
    let want = version(&core);
    let fresh = !live.exists() || version(&live) != want;
    if fresh {
        stop();
        back_up();
        let parent = live.parent().ok_or("no folder")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let next = parent.join(format!("{HOST_APP}.new"));
        let prev = parent.join(format!("{HOST_APP}.prev"));
        let _ = std::fs::remove_dir_all(&next);
        if !ditto(&core, &next) {
            let _ = std::fs::remove_dir_all(&next);
            return Err("Can't copy the core".into());
        }
        let _ = std::fs::remove_dir_all(&prev);
        if live.exists() {
            std::fs::rename(&live, &prev).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&next, &live).map_err(|e| e.to_string())?;
    }
    if fresh || !plist().exists() {
        write_unit().map_err(|e| e.to_string())?;
    }
    if fresh || !loaded() {
        start()?;
    }
    if serving(60) {
        return Ok(());
    }
    // A new core that won't serve: the one before it put back.
    let prev = live.with_file_name(format!("{HOST_APP}.prev"));
    if fresh && prev.exists() {
        stop();
        let _ = std::fs::remove_dir_all(&live);
        let _ = std::fs::rename(&prev, &live);
        if start().is_ok() && serving(60) {
            return Err("The new core didn't start; the one before it runs".into());
        }
    }
    Err("The core didn't start".into())
}

/// Restarts the core, as after its settings change.
pub fn restart() {
    if !ours() {
        return;
    }
    stop();
    if let Err(e) = start() {
        eprintln!("{e}");
    }
}
