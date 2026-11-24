//! This app's credential for its core, as the desktop's `bun/auth.ts` keeps it: the core from
//! `$SWITCH_CORE`, else this Mac's Switch config, else the core on this machine. The credential is
//! kept in the Keychain (the desktop's item: service "Switchboard", the core its account), else, when
//! the Keychain won't answer (as it may not for a build signed differently), in a file only this
//! user can read. On the core's own machine the core mints one at once; elsewhere the app pairs: it
//! asks with `POST /pair`, shows the code for the user to approve on another desktop (or with
//! `switch approve` on the core's machine), and polls. One the core stops taking (revoked, said again
//! and again) is dropped and paired again (`forget`, as net.rs dials). Tokens go only in headers, never in an
//! address or a log.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use security_framework::os::macos::keychain::SecKeychain;
use security_framework::passwords;
use serde_json::{Value, json};

use crate::json::gs;

pub const FALLBACK: &str = "http://127.0.0.1:4871";
/// The desktop app's Keychain service.
const SERVICE: &str = "Switchboard";
/// How many times running the core must say no before a token's dropped: a core starting up (a
/// redeploy) may say it once.
const REFUSALS: usize = 3;

#[derive(Clone)]
pub struct Auth {
    /// The core's HTTP origin.
    pub core: String,
    pub token: String,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// The core's HTTP origin.
pub fn core() -> String {
    let named = std::env::var("SWITCH_CORE").ok().or_else(|| {
        let text = std::fs::read_to_string(home().join(".switch/config.json")).ok()?;
        let v: Value = serde_json::from_str(&text).ok()?;
        Some(gs(&v, "core")).filter(|c| !c.is_empty())
    });
    let raw = named.unwrap_or_else(|| FALLBACK.into());
    let raw = raw.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1);
    match raw.find("://").map(|i| i + 3) {
        Some(start) => {
            let end = raw[start..].find('/').map(|i| start + i).unwrap_or(raw.len());
            raw[..end].to_string()
        }
        None => raw,
    }
}

/// The file kept when the Keychain won't answer, as the desktop's.
fn file() -> PathBuf {
    home().join(".switch/desktop-credential.json")
}

fn from_file() -> HashMap<String, String> {
    std::fs::read_to_string(file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn to_file(all: &HashMap<String, String>) {
    let _ = crate::platform::helpers::write_atomic(&file(), serde_json::to_string(all).unwrap_or_default().as_bytes(), Some(0o600));
}

/// The Keychain, asked without ever showing the user a prompt: an item another app made answers
/// nothing rather than asking.
fn quietly<T>(f: impl FnOnce() -> T) -> T {
    let _lock = SecKeychain::disable_user_interaction();
    f()
}

/// A build that isn't the live app keeps the credential it made in its own folder, never in the
/// live app's Keychain item or file.
fn own_file() -> PathBuf {
    crate::outbox::dir().join("credential.json")
}

fn own() -> HashMap<String, String> {
    std::fs::read_to_string(own_file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn set_own(all: &HashMap<String, String>) {
    let _ = crate::platform::helpers::write_atomic(&own_file(), serde_json::to_string(all).unwrap_or_default().as_bytes(), Some(0o600));
}

mod secret {
    use super::*;

    pub fn get(core: &str) -> Option<String> {
        if let Some(t) = own().remove(core) {
            return Some(t);
        }
        let kept = quietly(|| passwords::get_generic_password(SERVICE, core).ok().and_then(|b| String::from_utf8(b).ok()));
        log::info!("credential: the Keychain {}", if kept.is_some() { "answered" } else { "didn't answer" });
        kept.or_else(|| from_file().remove(core))
    }

    pub fn set(core: &str, value: &str) {
        if crate::outbox::quiet() {
            return;
        }
        if !crate::cutover::is_live() {
            let mut all = own();
            all.insert(core.into(), value.into());
            set_own(&all);
            return;
        }
        let kept = quietly(|| passwords::set_generic_password(SERVICE, core, value.as_bytes()).is_ok());
        if !kept {
            let mut all = from_file();
            all.insert(core.into(), value.into());
            to_file(&all);
        }
    }

    pub fn drop(core: &str) {
        // A quiet copy never drops the live app's credential.
        if crate::outbox::quiet() {
            return;
        }
        // Only the live app drops the live app's credential; another build drops its own.
        let mut mine = own();
        if mine.remove(core).is_some() {
            set_own(&mine);
            return;
        }
        if !crate::cutover::is_live() {
            return;
        }
        let _ = quietly(|| passwords::delete_generic_password(SERVICE, core));
        let mut all = from_file();
        if all.remove(core).is_some() {
            to_file(&all);
        }
    }
}

fn loopback(core: &str) -> bool {
    let host = core.split("://").nth(1).unwrap_or_default();
    host.starts_with("127.") || host.starts_with("localhost") || host.starts_with("[::1]")
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).stderr(std::process::Stdio::null()).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

fn host_name() -> String {
    run("/bin/hostname", &[]).unwrap_or_else(|| "mac".into())
}

fn computer_name() -> String {
    run("scutil", &["--get", "ComputerName"]).unwrap_or_else(host_name)
}

/// This Mac as the core names machines: its Tailscale name, else its host name.
pub fn machine_name() -> String {
    let fallback = host_name().split('.').next().unwrap_or("mac").to_lowercase();
    let tailscale = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].into_iter().find(|p| std::path::Path::new(p).exists());
    let Some(tailscale) = tailscale else { return fallback };
    run(tailscale, &["status", "--self", "--json"])
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.pointer("/Self/DNSName").and_then(Value::as_str).map(|d| d.split('.').next().unwrap_or_default().to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
}

/// Whether the core says no to `token` this once.
async fn refused(http: &reqwest::Client, core: &str, token: &str) -> bool {
    match http.get(format!("{core}/auth/self")).bearer_auth(token).send().await {
        Ok(r) => r.status() == reqwest::StatusCode::UNAUTHORIZED,
        Err(_) => false,
    }
}

/// Whether the core still takes `token`: false only when it says so again and again.
pub async fn good(http: &reqwest::Client, core: &str, token: &str) -> bool {
    for i in 0..REFUSALS {
        if i > 0 {
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        if !refused(http, core, token).await {
            return true;
        }
    }
    false
}

async fn post(http: &reqwest::Client, url: String, body: Value) -> Option<Value> {
    http.post(url).json(&body).send().await.ok()?.json().await.ok()
}

fn asking() -> Value {
    json!({ "name": computer_name(), "kind": "device", "scopes": ["client", "admin"] })
}

/// A credential straight from the core on its own machine.
async fn mint(http: &reqwest::Client, core: &str) -> Option<String> {
    let minted = post(http, format!("{core}/auth/mint"), asking()).await?;
    Some(gs(&minted, "token")).filter(|t| !t.is_empty())
}

/// Pairs, showing each code it waits on; the token once approved.
async fn pair(http: &reqwest::Client, core: &str, show: &impl Fn(String)) -> String {
    loop {
        let Some(asked) = post(http, format!("{core}/pair"), asking()).await else {
            tokio::time::sleep(Duration::from_secs(10)).await;
            continue;
        };
        let (pairing, token, code) = (gs(&asked, "pairing"), gs(&asked, "token"), gs(&asked, "code"));
        if pairing.is_empty() || token.is_empty() || code.is_empty() {
            tokio::time::sleep(Duration::from_secs(10)).await;
            continue;
        }
        show(code);
        let status = loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let polled: Option<Value> = async { http.get(format!("{core}/pair/{pairing}")).bearer_auth(&token).send().await.ok()?.json().await.ok() }.await;
            let status = polled.map(|p| gs(&p, "status")).filter(|s| !s.is_empty()).unwrap_or_else(|| "waiting".into());
            if status != "waiting" {
                break status;
            }
        };
        if status == "approved" {
            return token;
        }
    }
}

/// A credential for `core`, pairing if it must; `show` hears each code it waits on.
pub async fn credential(http: &reqwest::Client, core: &str, show: impl Fn(String)) -> String {
    let mut token = secret::get(core);
    log::info!("credential: {}", if token.is_some() { "kept" } else { "none kept" });
    if let Some(t) = &token
        && !good(http, core, t).await
    {
        secret::drop(core);
        token = None;
    }
    if let Some(t) = token {
        return t;
    }
    // A quiet copy makes no credential of its own (minting and pairing are writes): unpaired, it
    // waits.
    if crate::outbox::quiet() {
        log::warn!("credential: none kept, and a quiet copy doesn't pair");
        std::future::pending::<()>().await;
    }
    let token = match if loopback(core) { mint(http, core).await } else { None } {
        Some(t) => {
            log::info!("credential: minted");
            t
        }
        None => pair(http, core, &show).await,
    };
    secret::set(core, &token);
    token
}

/// Drops the credential for `core`: the core no longer takes it (net.rs then finds or pairs another).
pub fn forget(core: &str) {
    secret::drop(core);
}

/// Keeps this app paired (`keepPaired`): every minute, whether the core still takes the credential;
/// once it doesn't (said again and again), the socket dials again, and net.rs drops it and pairs
/// again.
pub fn keep_paired(net: crate::net::Net) {
    let rt = net.rt.clone();
    rt.spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            if let Some(a) = net.auth()
                && !good(&net.client(), &a.core, &a.token).await
            {
                net.redial();
            }
        }
    });
}
