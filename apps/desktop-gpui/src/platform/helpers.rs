//! The app's native helpers (native/, built by build.rs), beside its binary: in the bundle,
//! Contents/MacOS; in a run from the target folder, the folder (the desktop's `bun/native.ts`).

use std::path::PathBuf;

pub fn native_helper(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    [dir.join(name), dir.join("../Resources/bin").join(name)].into_iter().find(|p| p.exists())
}

/// This Mac's home folder.
pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// Writes `data` to `path` whole: beside itself first, then moved in, so no half a file is ever read.
pub fn write_atomic(path: &std::path::Path, data: &[u8], mode: Option<u32>) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let part = path.with_extension(format!("{}.part", std::process::id()));
    std::fs::write(&part, data)?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&part, std::fs::Permissions::from_mode(mode))?;
    }
    std::fs::rename(&part, path)
}

/// Milliseconds since the epoch.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.).unwrap_or(0.)
}

/// A test copy run beside the live app (`SWITCH_GPUI_QUIET=1`, as the outbox has it, or the
/// desktop's `SWITCH_QUIET=1`) neither reports nor dials in as the desktop.
pub fn quiet() -> bool {
    crate::outbox::quiet()
}

/// The app bundle this runs from: …/Name.app.
pub fn bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let s = exe.to_string_lossy();
    let at = s.find(".app/")?;
    Some(PathBuf::from(&s[..at + 4]))
}

/// The app's id, as its bundle says; `switch.local.dev` outside one.
pub static ID: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    bundle()
        .and_then(|app| {
            let out = std::process::Command::new("/usr/bin/plutil").args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"]).arg(app.join("Contents/Info.plist")).output().ok()?;
            out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "switch.local.dev".into())
});

/// The app's own state folder: ~/Library/Application Support/<id>.
pub fn support() -> PathBuf {
    home().join("Library/Application Support").join(&*ID)
}
