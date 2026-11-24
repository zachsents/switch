//! Build tasks for the suite, run as `cargo xtask <task> <app>`.
//!
//! - `bundle <app>` builds the app in release mode and assembles `<Name>.app` in
//!   `target/release/bundle`, with its Info.plist, icon and an ad-hoc signature.
//! - `install <app>` bundles the app, then puts it in `~/Applications`, replacing an older copy.
//!
//! An app opts in with `[package.metadata.bundle]` in its Cargo.toml: `name` is the name people
//! see, and `icon` names the kit icon (in `crates/kit/assets/icons`) drawn on the app icon. An
//! app that works on files lists their uniform type identifiers in `opens`, and Finder offers it
//! in their Open With menu. An app that records says why in `microphone` and `screen_capture`,
//! which macOS shows when it asks for permission, and can need a newer macOS with
//! `minimum_macos`.
//!
//! Bundles are signed with the first Developer ID Application identity in the keychain, or else
//! an Apple Development one, so macOS keeps an app's permissions across rebuilds; an ad-hoc
//! signature changes with every build. `PLAIN_SIGNING_IDENTITY` names another identity, or `-`
//! for ad hoc.

use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
};

use resvg::{tiny_skia, usvg};
use serde::Deserialize;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Rust's default deployment target on Apple Silicon, which is what release builds target unless
/// `MACOSX_DEPLOYMENT_TARGET` says otherwise.
const DEFAULT_MINIMUM_MACOS: &str = "11.0";

const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

fn main() -> ExitCode {
    let arguments: Vec<_> = env::args().skip(1).collect();
    let result = match arguments.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["bundle", app] => bundle(app).map(|_| ()),
        ["install", app] => bundle(app).and_then(|bundle| install(app, &bundle)),
        _ => Err("usage: cargo xtask (bundle | install) <app>".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

/// The parts of `cargo metadata` that bundling needs.
#[derive(Deserialize)]
struct Workspace {
    packages: Vec<Package>,
    workspace_root: PathBuf,
    target_directory: PathBuf,
}

#[derive(Deserialize)]
struct Package {
    name: String,
    version: String,
    metadata: Option<PackageMetadata>,
}

#[derive(Deserialize)]
struct PackageMetadata {
    bundle: Option<BundleMetadata>,
}

/// `[package.metadata.bundle]` in an app's Cargo.toml.
#[derive(Deserialize)]
struct BundleMetadata {
    name: String,
    icon: String,
    #[serde(default)]
    opens: Vec<String>,
    /// Why the app uses the microphone, shown when macOS asks for permission.
    microphone: Option<String>,
    /// Why the app records the screen, shown when macOS asks for permission.
    screen_capture: Option<String>,
    /// The oldest macOS the app runs on, when it needs newer than the default.
    minimum_macos: Option<String>,
}

/// Builds `app` in release mode and assembles its `.app` bundle. Returns the bundle's path.
fn bundle(app: &str) -> Result<PathBuf> {
    let workspace: Workspace = serde_json::from_slice(&run(Command::new(cargo()).args([
        "metadata",
        "--format-version",
        "1",
        "--no-deps",
    ]))?)?;
    let package = workspace
        .packages
        .iter()
        .find(|package| package.name == app)
        .ok_or_else(|| format!("there is no package named `{app}`"))?;
    let metadata = package
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.bundle.as_ref())
        .ok_or_else(|| format!("`{app}` has no [package.metadata.bundle] in its Cargo.toml"))?;
    let (name, icon) = (&metadata.name, &metadata.icon);
    let glyph_path = workspace
        .workspace_root
        .join("crates/kit/assets/icons")
        .join(format!("{icon}.svg"));
    let glyph = fs::read_to_string(&glyph_path)
        .map_err(|error| format!("can't read {}: {error}", glyph_path.display()))?;

    run(Command::new(cargo()).args(["build", "--release", "--package", app]))?;

    let release = workspace.target_directory.join("release");
    let bundles = release.join("bundle");
    let bundle = bundles.join(format!("{name}.app"));
    let contents = bundle.join("Contents");
    remove_if_present(&bundle)?;
    fs::create_dir_all(contents.join("MacOS"))?;
    fs::create_dir_all(contents.join("Resources"))?;
    fs::copy(release.join(app), contents.join("MacOS").join(app))?;
    fs::write(
        contents.join("Info.plist"),
        info_plist(app, &package.version, metadata),
    )?;
    write_icns(
        &icon_svg(&glyph),
        &contents.join("Resources/AppIcon.icns"),
        &bundles,
    )?;
    // Seals the Info.plist and icon into the signature, so macOS treats the bundle as one app.
    let identity = signing_identity()?;
    run(Command::new("codesign")
        .args(["--force", "--timestamp=none", "--sign", &identity])
        .arg(&bundle))?;
    println!("bundled {}", bundle.display());
    Ok(bundle)
}

/// Copies an app's bundle into `~/Applications`, replacing an older copy, and registers it with
/// Launch Services so Finder and Spotlight show it with its icon right away.
fn install(app: &str, bundle: &Path) -> Result {
    let applications = env::home_dir()
        .ok_or("can't find the home folder")?
        .join("Applications");
    let installed = applications.join(bundle.file_name().expect("bundles have a file name"));
    fs::create_dir_all(&applications)?;
    remove_if_present(&installed)?;
    run(Command::new("ditto").arg(bundle).arg(&installed))?;
    run(Command::new(LSREGISTER).arg("-f").arg(&installed))?;
    println!("installed {}", installed.display());

    let running = run(Command::new("lsappinfo")
        .arg("find")
        .arg(format!("bundleid={}", identifier(app))))?;
    if !String::from_utf8_lossy(&running).trim().is_empty() {
        let name = installed.file_stem().expect("bundles have a file name");
        println!(
            "{} is still running the previous build. Quit it and open it again to update.",
            name.display()
        );
    }
    Ok(())
}

/// The `cargo` that is running this task.
fn cargo() -> std::ffi::OsString {
    env::var_os("CARGO").unwrap_or_else(|| "cargo".into())
}

/// Runs a command with its errors shown, and returns what it printed. Fails if the command does.
fn run(command: &mut Command) -> Result<Vec<u8>> {
    let output = command.stderr(Stdio::inherit()).output()?;
    if !output.status.success() {
        return Err(format!("{command:?} failed with {}", output.status).into());
    }
    Ok(output.stdout)
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

fn identifier(app: &str) -> String {
    format!("com.plain.{app}")
}

/// The Info.plist for `app` (the package and executable name), shown to people as `name`.
/// The identity to sign bundles with: `PLAIN_SIGNING_IDENTITY` if set, or the first Developer
/// ID Application identity in the keychain, or an Apple Development one, or ad hoc (`-`).
fn signing_identity() -> Result<String> {
    if let Ok(identity) = env::var("PLAIN_SIGNING_IDENTITY") {
        return Ok(identity);
    }
    let listed = run(Command::new("security").args(["find-identity", "-v", "-p", "codesigning"]))?;
    let listed = String::from_utf8_lossy(&listed);
    let names: Vec<&str> = listed
        .lines()
        .filter_map(|line| line.split('"').nth(1))
        .collect();
    let preferred = ["Developer ID Application:", "Apple Development:"]
        .iter()
        .find_map(|kind| names.iter().find(|name| name.starts_with(kind)));
    Ok(preferred.map_or_else(|| "-".to_string(), |name| name.to_string()))
}

fn info_plist(app: &str, version: &str, metadata: &BundleMetadata) -> String {
    let identifier = identifier(app);
    let name = &metadata.name;
    let document_types = document_types(name, &metadata.opens);
    let minimum = metadata.minimum_macos.clone().unwrap_or_else(|| {
        env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| DEFAULT_MINIMUM_MACOS.to_string())
    });
    let usage = [
        ("NSMicrophoneUsageDescription", &metadata.microphone),
        ("NSScreenCaptureUsageDescription", &metadata.screen_capture),
    ]
    .iter()
    .filter_map(|(key, reason)| {
        reason
            .as_ref()
            .map(|reason| format!("\n\t<key>{key}</key>\n\t<string>{reason}</string>"))
    })
    .collect::<String>();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>{name}</string>
	<key>CFBundleExecutable</key>
	<string>{app}</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundleIdentifier</key>
	<string>{identifier}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>{name}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>{version}</string>
	<key>CFBundleVersion</key>
	<string>{version}</string>
	<key>LSMinimumSystemVersion</key>
	<string>{minimum}</string>
	<key>NSHighResolutionCapable</key>
	<true/>{document_types}{usage}
</dict>
</plist>
"#
    )
}

/// Declares the files Finder offers the app for in Open With, by uniform type identifier. At the
/// "Alternate" rank the app never becomes their default, and as a "Viewer" it never claims to
/// save over them.
fn document_types(name: &str, opens: &[String]) -> String {
    if opens.is_empty() {
        return String::new();
    }
    let types: String = opens
        .iter()
        .map(|identifier| format!("\n\t\t\t\t<string>{identifier}</string>"))
        .collect();
    format!(
        "
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key>
			<string>{name}</string>
			<key>CFBundleTypeRole</key>
			<string>Viewer</string>
			<key>LSHandlerRank</key>
			<string>Alternate</string>
			<key>LSItemContentTypes</key>
			<array>{types}
			</array>
		</dict>
	</array>"
    )
}

/// The app icon, drawn on a 1024px canvas: a raised tile in the kit's light button material (a
/// gradient face, a gloss over the top half, a bevel and a shadow) with the app's glyph as its
/// label. The tile follows Apple's macOS icon grid, an 824px squircle centered on the canvas.
fn icon_svg(glyph: &str) -> String {
    let tile = squircle(100., 100., 824.);
    // The rest of the canvas with a tile-shaped hole. Clipped to the tile and drawn with the hole
    // shifted, it leaves a thin band along one inside edge, like a CSS inset shadow.
    let inset = |offset: f32| format!("M0 0H1024V1024H0Z {}", squircle(100., 100. + offset, 824.));
    // The glyph keeps its own viewBox and draws at 600px, centered on the tile.
    let glyph = glyph.replacen(
        "<svg",
        r#"<svg x="212" y="212" width="600" height="600""#,
        1,
    );
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#d9d9d9"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.17"/>
    </linearGradient>
    <clipPath id="tile"><path d="{tile}"/></clipPath>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="contact-blur"/>
      <feOffset in="contact-blur" dy="4" result="contact-offset"/>
      <feComponentTransfer in="contact-offset" result="contact">
        <feFuncA type="linear" slope="0.22"/>
      </feComponentTransfer>
      <feGaussianBlur in="SourceAlpha" stdDeviation="14" result="soft-blur"/>
      <feOffset in="soft-blur" dy="14" result="soft-offset"/>
      <feComponentTransfer in="soft-offset" result="soft">
        <feFuncA type="linear" slope="0.2"/>
      </feComponentTransfer>
      <feMerge>
        <feMergeNode in="soft"/>
        <feMergeNode in="contact"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <path d="{tile}" fill="url(#face)" filter="url(#lift)"/>
  <g clip-path="url(#tile)">
    <rect x="0" y="100" width="1024" height="412" fill="url(#gloss)"/>
    <path d="{highlight}" fill="#ffffff" fill-rule="evenodd"/>
    <path d="{shade}" fill="#000000" fill-opacity="0.12" fill-rule="evenodd"/>
    <path d="{tile}" fill="none" stroke="#000000" stroke-opacity="0.2" stroke-width="6"/>
  </g>
  {glyph}
</svg>"##,
        highlight = inset(6.),
        shade = inset(-6.),
    )
}

/// An SVG path for a square with Apple's continuous corners, as on macOS app icons, with its
/// top left at (`x`, `y`). The corner curve is the common reconstruction of the iOS rounded
/// rectangle, with the 185.4px corner radius from Apple's 1024px icon template, scaled to `size`.
fn squircle(x: f32, y: f32, size: f32) -> String {
    // The top right corner as (distance from the right edge, distance from the top edge), in
    // corner radii: a start point, then three cubic curves of three points each.
    const CORNER: [(f32, f32); 10] = [
        (1.528_665, 0.),
        (1.088_493, 0.),
        (0.868_407, 0.),
        (0.669_934, 0.065_496),
        (0.372_824, 0.169_059),
        (0.169_059, 0.372_824),
        (0.065_496, 0.669_934),
        (0., 0.868_407),
        (0., 1.088_493),
        (0., 1.528_665),
    ];
    let radius = size * 185.4 / 824.;
    let half = size / 2.;
    let points: Vec<String> = (0..4)
        .flat_map(|quarter| {
            CORNER
                .iter()
                .enumerate()
                .map(move |(index, &(right, top))| {
                    // Relative to the center, then turned clockwise a quarter turn per corner.
                    let (dx, dy) = (half - right * radius, top * radius - half);
                    let (dx, dy) = match quarter {
                        0 => (dx, dy),
                        1 => (-dy, dx),
                        2 => (-dx, -dy),
                        _ => (dy, -dx),
                    };
                    let command = match index {
                        0 if quarter == 0 => "M",
                        0 => "L",
                        1 | 4 | 7 => "C",
                        _ => "",
                    };
                    format!("{command}{} {}", x + half + dx, y + half + dy)
                })
        })
        .collect();
    format!("{}Z", points.join(" "))
}

/// Renders the icon at every size an `.icns` file holds into `scratch`, then packs them into
/// `icns` with `iconutil`.
fn write_icns(svg: &str, icns: &Path, scratch: &Path) -> Result {
    let tree = usvg::Tree::from_str(svg, &usvg::Options::default())?;
    let iconset = scratch.join("AppIcon.iconset");
    remove_if_present(&iconset)?;
    fs::create_dir_all(&iconset)?;
    for points in [16, 32, 128, 256, 512] {
        for (scale, suffix) in [(1, ""), (2, "@2x")] {
            let pixels = points * scale;
            let mut pixmap =
                tiny_skia::Pixmap::new(pixels, pixels).expect("icon sizes are non-zero");
            let zoom = pixels as f32 / tree.size().width();
            resvg::render(
                &tree,
                tiny_skia::Transform::from_scale(zoom, zoom),
                &mut pixmap.as_mut(),
            );
            pixmap.save_png(iconset.join(format!("icon_{points}x{points}{suffix}.png")))?;
        }
    }
    run(Command::new("iconutil")
        .args(["--convert", "icns", "--output"])
        .arg(icns)
        .arg(&iconset))?;
    Ok(())
}
