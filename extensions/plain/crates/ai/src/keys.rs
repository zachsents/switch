//! API keys for AI providers, shared by every app in the suite. A provider's key comes from, in
//! order: one saved in Plain, the app's own environment (when it was started from a terminal),
//! or the user's login shell.
//!
//! Saved keys go in the login keychain through macOS's `security` tool rather than the
//! Keychain API, so every app in the suite can read them without a password prompt, even after
//! being rebuilt.

use std::{
    fmt,
    io::Write,
    process::{Command, Stdio},
};

use crate::shell;

/// The keychain service saved keys are filed under.
const SERVICE: &str = "plain";

/// A company whose AI models the apps can use.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    /// Vercel's AI Gateway, which reaches many providers' models with one key.
    Gateway,
    OpenAi,
    Anthropic,
}

impl Provider {
    pub const ALL: [Self; 3] = [Self::Gateway, Self::OpenAi, Self::Anthropic];

    pub fn name(self) -> &'static str {
        match self {
            Self::Gateway => "Vercel AI Gateway",
            Self::OpenAi => "OpenAI",
            Self::Anthropic => "Anthropic",
        }
    }

    /// The environment variables that hold its key, the usual one first.
    pub fn variables(self) -> &'static [&'static str] {
        match self {
            Self::Gateway => &["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"],
            Self::OpenAi => &["OPENAI_API_KEY"],
            Self::Anthropic => &["ANTHROPIC_API_KEY"],
        }
    }

    /// The name its saved key is filed under.
    fn account(self) -> &'static str {
        self.variables()[0]
    }
}

/// Every variable any provider's key can be in, the only ones read from the shell.
fn all_variables() -> Vec<&'static str> {
    Provider::ALL
        .iter()
        .flat_map(|provider| provider.variables())
        .copied()
        .collect()
}

/// Where a key was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// Saved in Plain.
    Saved,
    /// In the environment the app was started with.
    Environment(&'static str),
    /// In the user's login shell.
    Shell(&'static str),
}

/// An API key. It never prints its value.
#[derive(Clone)]
pub struct Key {
    value: String,
    pub provider: Provider,
    pub source: Source,
}

impl Key {
    pub fn value(&self) -> &str {
        &self.value
    }

    /// The last four characters, enough to tell keys apart, like "…a1b2".
    pub fn hint(&self) -> String {
        let tail: String = self
            .value
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("…{tail}")
    }

    /// Where the key came from, in plain words, like "From your shell (OPENAI_API_KEY)".
    pub fn origin(&self) -> String {
        match self.source {
            Source::Saved => "Saved in Plain".into(),
            Source::Environment(variable) => format!("From the environment ({variable})"),
            Source::Shell(variable) => format!("From your shell ({variable})"),
        }
    }
}

impl fmt::Debug for Key {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter
            .debug_struct("Key")
            .field("provider", &self.provider)
            .field("source", &self.source)
            .field("value", &self.hint())
            .finish()
    }
}

/// The key to use for `provider`, if there is one. The first call may wait a few seconds for
/// the login shell, so call it off the main thread.
pub fn find(provider: Provider) -> Option<Key> {
    let key = |value: String, source| Key {
        value,
        provider,
        source,
    };
    saved(provider)
        .map(|value| key(value, Source::Saved))
        .or_else(|| {
            provider.variables().iter().find_map(|variable| {
                std::env::var(variable)
                    .ok()
                    .filter(|value| !value.is_empty())
                    .map(|value| key(value, Source::Environment(variable)))
            })
        })
        .or_else(|| {
            let wanted = all_variables();
            provider.variables().iter().find_map(|variable| {
                shell::variable(variable, &wanted)
                    .filter(|value| !value.is_empty())
                    .map(|value| key(value, Source::Shell(variable)))
            })
        })
}

/// The key saved in Plain for `provider`, if any.
fn saved(provider: Provider) -> Option<String> {
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            SERVICE,
            "-a",
            provider.account(),
            "-w",
        ])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (output.status.success() && !value.is_empty()).then_some(value)
}

/// Saves a key for `provider` in Plain, replacing any saved before. It takes precedence over
/// keys in the environment. The key goes to `security` through its standard input, never its
/// command line, where other processes could see it.
pub fn save(provider: Provider, value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.contains(['"', '\\', '\n']) {
        return Err("That doesn't look like an API key".into());
    }
    let mut child = Command::new("/usr/bin/security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Couldn't reach the keychain: {error}"))?;
    let command = format!(
        "add-generic-password -U -s {SERVICE} -a {} -l \"Plain: {}\" -w \"{value}\"\n",
        provider.account(),
        provider.name()
    );
    child
        .stdin
        .take()
        .ok_or("Couldn't reach the keychain")?
        .write_all(command.as_bytes())
        .map_err(|error| format!("Couldn't reach the keychain: {error}"))?;
    let status = child
        .wait()
        .map_err(|error| format!("Couldn't reach the keychain: {error}"))?;
    if status.success() && saved(provider).as_deref() == Some(value) {
        Ok(())
    } else {
        Err("The keychain didn't keep the key".into())
    }
}

/// Removes the key saved in Plain for `provider`, so one from the environment is used again.
pub fn forget(provider: Provider) -> Result<(), String> {
    Command::new("/usr/bin/security")
        .args([
            "delete-generic-password",
            "-s",
            SERVICE,
            "-a",
            provider.account(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|_| ())
        .map_err(|error| format!("Couldn't reach the keychain: {error}"))
}
