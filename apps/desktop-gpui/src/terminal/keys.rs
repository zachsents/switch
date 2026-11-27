//! A key as a terminal sends it (xterm's encoding, as Terminal.app, Alacritty and Ghostty send it):
//! what a keystroke writes to the shell, given the screen's modes. Words typed (a letter, ⌥'s
//! letters, a composed one) come through the input handler instead, so the Mac's input methods
//! work; this is every key that isn't words.

use alacritty_terminal::term::TermMode;
use gpui::Keystroke;

/// xterm's modifier parameter: 1 plus shift 1, alt 2, control 4.
fn param(k: &Keystroke) -> u8 {
    let m = &k.modifiers;
    1 + u8::from(m.shift) + 2 * u8::from(m.alt) + 4 * u8::from(m.control)
}

/// A cursor or navigation key's final letter: `ESC [ <x>`, `ESC O <x>` in application mode.
fn cursor_letter(key: &str) -> Option<char> {
    Some(match key {
        "up" => 'A',
        "down" => 'B',
        "right" => 'C',
        "left" => 'D',
        "home" => 'H',
        "end" => 'F',
        _ => return None,
    })
}

/// A key written `ESC [ <n> ~`.
fn tilde_number(key: &str) -> Option<u8> {
    Some(match key {
        "insert" => 2,
        "delete" => 3,
        "pageup" => 5,
        "pagedown" => 6,
        "f5" => 15,
        "f6" => 17,
        "f7" => 18,
        "f8" => 19,
        "f9" => 20,
        "f10" => 21,
        "f11" => 23,
        "f12" => 24,
        _ => return None,
    })
}

/// F1 to F4: `ESC O P` to `ESC O S`.
fn ss3_function(key: &str) -> Option<char> {
    Some(match key {
        "f1" => 'P',
        "f2" => 'Q',
        "f3" => 'R',
        "f4" => 'S',
        _ => return None,
    })
}

/// Control with a key: its C0 byte (⌃A is 1, ⌃[ is ESC, ⌃Space and ⌃@ are NUL).
fn control_byte(key: &str) -> Option<u8> {
    let mut chars = key.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return if key == "space" { Some(0) } else { None };
    }
    match c.to_ascii_lowercase() {
        l @ 'a'..='z' => Some(l as u8 - b'a' + 1),
        '@' | '2' => Some(0),
        '[' | '3' => Some(0x1b),
        '\\' | '4' => Some(0x1c),
        ']' | '5' => Some(0x1d),
        '^' | '6' => Some(0x1e),
        '_' | '-' | '7' => Some(0x1f),
        '/' => Some(0x1f),
        '8' | '?' => Some(0x7f),
        _ => None,
    }
}

/// What a keystroke writes to the shell, or None when it's words for the input handler (or a key
/// the terminal doesn't take, as ⌘'s).
pub fn bytes(k: &Keystroke, mode: TermMode) -> Option<Vec<u8>> {
    let m = &k.modifiers;
    if m.platform || m.function && cursor_letter(&k.key).is_none() && tilde_number(&k.key).is_none() {
        return None;
    }
    let key = k.key.as_str();
    let p = param(k);
    let esc = |s: &str| {
        let mut v = vec![0x1b];
        v.extend_from_slice(s.as_bytes());
        v
    };
    if let Some(x) = cursor_letter(key) {
        // ⌥← and ⌥→ move by words, as the Mac's terminals send them.
        if m.alt && !m.shift && !m.control && (key == "left" || key == "right") {
            return Some(esc(if key == "left" { "b" } else { "f" }));
        }
        if p > 1 {
            return Some(esc(&format!("[1;{p}{x}")));
        }
        let app = mode.contains(TermMode::APP_CURSOR);
        return Some(esc(&format!("{}{x}", if app { 'O' } else { '[' })));
    }
    if let Some(n) = tilde_number(key) {
        return Some(esc(&if p > 1 { format!("[{n};{p}~") } else { format!("[{n}~") }));
    }
    if let Some(x) = ss3_function(key) {
        return Some(esc(&if p > 1 { format!("[1;{p}{x}") } else { format!("O{x}") }));
    }
    match key {
        "escape" => return Some(if m.alt { vec![0x1b, 0x1b] } else { vec![0x1b] }),
        "enter" => {
            return Some(match (m.alt, m.shift) {
                (true, _) => vec![0x1b, b'\r'],
                // ⇧↩ a line feed, which Claude Code and others read as a new line.
                (false, true) => vec![b'\n'],
                _ => vec![b'\r'],
            });
        }
        "tab" => return Some(if m.shift { esc("[Z") } else { vec![b'\t'] }),
        "backspace" => {
            return Some(match (m.alt, m.control) {
                (true, _) => vec![0x1b, 0x7f],
                (false, true) => vec![0x08],
                _ => vec![0x7f],
            });
        }
        "space" if m.control => return Some(vec![0]),
        _ => {}
    }
    if m.control {
        let b = control_byte(key)?;
        return Some(if m.alt { vec![0x1b, b] } else { vec![b] });
    }
    None
}

/// Words pasted: in brackets when the program asked for them (so a shell doesn't run each line),
/// else with the Mac's new lines as returns.
pub fn paste(text: &str, mode: TermMode) -> Vec<u8> {
    if mode.contains(TermMode::BRACKETED_PASTE) {
        // A pasted end marker would end the paste early.
        let clean = text.replace("\x1b[201~", "");
        let mut v = b"\x1b[200~".to_vec();
        v.extend_from_slice(clean.as_bytes());
        v.extend_from_slice(b"\x1b[201~");
        v
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}
