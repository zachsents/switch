//! What's this Mac's own, not the user's everywhere (the desktop's `bun/local.ts`): launching at
//! login (a LaunchAgent that opens the app) and whether updates go in by themselves (a file beside
//! the app's other state).

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// This Mac's own settings, and what went wrong setting them.
#[derive(Clone, Debug, Default)]
pub struct Local {
    pub login: bool,
    pub auto_update: bool,
    pub error: Option<String>,
}

/// The app bundle this runs from: …/Name.app/Contents/MacOS/switch-gpui.
fn bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let s = exe.to_string_lossy();
    let at = s.find(".app/")?;
    Some(PathBuf::from(&s[..at + 4]))
}

/// The bundle's identifier, from its Info.plist.
fn id() -> Option<String> {
    let app = bundle()?;
    let out = Command::new("/usr/bin/plutil").args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"]).arg(app.join("Contents/Info.plist")).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

struct Places {
    app: Option<PathBuf>,
    label: String,
    domain: String,
    agent: PathBuf,
    file: PathBuf,
    bundled: bool,
}

fn places() -> Places {
    let id = id();
    let bundled = id.is_some();
    let id = id.unwrap_or_else(|| "switch.local.dev".into());
    let home = dirs::home_dir().unwrap_or_default();
    let label = format!("{id}.login");
    Places {
        app: bundle(),
        agent: home.join("Library/LaunchAgents").join(format!("{label}.plist")),
        file: home.join("Library/Application Support").join(&id).join("local.json"),
        domain: format!("gui/{}", unsafe { libc_getuid() }),
        label,
        bundled,
    }
}

unsafe extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

fn registered(p: &Places) -> bool {
    Command::new("/bin/launchctl").args(["print", &format!("{}/{}", p.domain, p.label)]).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

fn launch(args: &[&str]) -> Result<(), String> {
    let s = Command::new("/bin/launchctl").args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|e| e.to_string())?;
    if s.success() { Ok(()) } else { Err(format!("macOS login registration failed ({}). Try again in General settings.", s.code().unwrap_or(-1))) }
}

fn xml(v: &str) -> String {
    v.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Writes a file whole or not at all: a temp beside it, renamed over it.
fn write_atomic(path: &PathBuf, body: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn auto_update(p: &Places) -> bool {
    std::fs::read(&p.file).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()).is_none_or(|v| v.get("autoUpdate") != Some(&serde_json::Value::Bool(false)))
}

pub fn local() -> Local {
    let p = places();
    Local { login: p.agent.exists() && registered(&p), auto_update: auto_update(&p), error: None }
}

/// Sets what's given; what isn't stays. Answers what it now is.
pub fn set_local(login: Option<bool>, auto: Option<bool>) -> Local {
    // A quiet copy touches neither the live login item nor its settings.
    if crate::outbox::quiet() {
        return local();
    }
    let p = places();
    let done = (|| -> Result<(), String> {
        match login {
            Some(true) => {
                let app = p.app.as_ref().filter(|_| p.bundled).ok_or("Launch at login requires an installed app bundle.")?;
                if !registered(&p) {
                    write_atomic(
                        &p.agent,
                        &format!(
                            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{}</string>\n<key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-g</string><string>-a</string><string>{}</string></array>\n<key>RunAtLoad</key><true/>\n</dict></plist>\n",
                            xml(&p.label),
                            xml(&app.to_string_lossy())
                        ),
                    )?;
                    launch(&["enable", &format!("{}/{}", p.domain, p.label)])?;
                    launch(&["bootstrap", &p.domain, &p.agent.to_string_lossy()])?;
                    if !registered(&p) {
                        return Err("macOS did not register the login item. Try again in General settings.".into());
                    }
                }
            }
            Some(false) => {
                if registered(&p) {
                    launch(&["bootout", &format!("{}/{}", p.domain, p.label)])?;
                }
                let _ = std::fs::remove_file(&p.agent);
            }
            None => {}
        }
        if let Some(a) = auto {
            write_atomic(&p.file, &serde_json::json!({ "autoUpdate": a }).to_string())?;
        }
        Ok(())
    })();
    let mut now = local();
    if let Err(e) = done {
        now.error = Some(if e.is_empty() { "Could not save this Mac's settings. Try again.".into() } else { e });
    }
    now
}
