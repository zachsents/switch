//! The app's native parts, as the desktop's `src/native/build.sh` builds them: the dictation and
//! Quick Look helpers (Swift, with the Command Line Tools' swiftc; SpeechAnalyzer is macOS 26's),
//! each left beside the app's binary in the target folder, where a run from there finds it and
//! scripts/bundle.sh puts it in the app; and the window's picture (`native/snapshot.m`), compiled
//! into the app.

use std::path::PathBuf;
use std::process::Command;
use std::{env, fs};

fn main() {
    swift("dictation", "switch-dictation", true);
    swift("quicklook", "switch-quicklook", false);
    println!("cargo::rerun-if-changed=native/snapshot.m");
    cc::Build::new().file("native/snapshot.m").flag("-fobjc-arc").flag("-fmodules").compile("switch_snapshot");
    println!("cargo::rustc-link-lib=framework=AppKit");
    println!("cargo::rustc-link-lib=framework=WebKit");
}

fn swift(source: &str, name: &str, library: bool) {
    println!("cargo::rerun-if-changed=native/{source}.swift");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
    let helper = out.join(name);
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").expect("cargo sets the target").as_str() {
        "aarch64" => "arm64".to_string(),
        other => other.to_string(),
    };
    let mut c = Command::new("xcrun");
    c.args(["swiftc", "-O"]);
    if library {
        c.arg("-parse-as-library");
    }
    let built = c
        .args(["-target", &format!("{arch}-apple-macos26.0"), "-o"])
        .arg(&helper)
        .arg(format!("native/{source}.swift"))
        .status()
        .expect("xcrun runs (install the Command Line Tools: xcode-select --install)");
    assert!(built.success(), "swiftc couldn't build native/{source}.swift");
    // OUT_DIR is <target>/<profile>/build/<crate>-<hash>/out.
    if let Some(profile) = out.ancestors().nth(3) {
        let beside = profile.join(name);
        let partial = profile.join(format!("{name}.partial"));
        fs::copy(&helper, &partial).and_then(|_| fs::rename(&partial, &beside)).expect("the helper copies beside the app");
    }
}
