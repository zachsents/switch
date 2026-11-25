//! The window's frames as pictures, for looking at the app on a Mac whose screen can't be captured
//! (built with `--features shot`). `$SWITCH_GPUI_SHOT` is the folder they go in; `$SWITCH_GPUI_PAGES`
//! the pages to visit, by space id, `<space>@<seq>` (its chat at that line) or `thread:<id>`, comma
//! separated; each is drawn and saved.

use std::time::Duration;

use gpui::{AnyWindowHandle, App, AppContext};

use crate::model::model;
use crate::nav::{Nav, Page};

pub fn start(window: AnyWindowHandle, cx: &mut App) {
    let Ok(dir) = std::env::var("SWITCH_GPUI_SHOT") else { return };
    // Which tree this copy was built from, so a run on a shared Mac can tell it's its own.
    eprintln!("shot: built from {}", env!("CARGO_MANIFEST_DIR"));
    let pages: Vec<String> = std::env::var("SWITCH_GPUI_PAGES").unwrap_or_else(|_| "home".into()).split(',').map(str::to_string).collect();
    let _ = std::fs::create_dir_all(&dir);
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor().timer(Duration::from_millis(200)).await;
            if cx.update(|cx| model(cx).read(cx).brain.ready) {
                break;
            }
        }
        // `widgets`: each space with widgets placed; `asks`: each space with asks, open or lately
        // closed; `ask:*`: each open ask's window (`ask:<id>` one).
        let pages: Vec<String> = cx.update(|cx| {
            let m = model(cx).read(cx);
            let mut out = vec![];
            for p in &pages {
                match p.as_str() {
                    "widgets" => {
                        let mut seen = vec![];
                        for w in &m.brain.placed {
                            if !seen.contains(&w.space) {
                                seen.push(w.space.clone());
                            }
                        }
                        out.extend(seen);
                    }
                    "asks" => {
                        let mut seen: Vec<String> = vec![];
                        for i in m.brain.items.open.values().chain(m.brain.items.closed.iter()) {
                            if !seen.contains(&i.space) {
                                seen.push(i.space.clone());
                            }
                        }
                        out.extend(seen);
                    }
                    "ask:*" => out.extend(m.brain.items.open.keys().map(|k| format!("ask:{k}"))),
                    _ => out.push(p.clone()),
                }
            }
            out
        });
        let mut last = window;
        for (i, page) in pages.iter().enumerate() {
            // Input to the window last shot, through its own event path: `click:<x>:<y>` (a press
            // and release there, in points), `dbl:<x>:<y>` (two), `hover:<x>:<y>` (the pointer there),
            // `key:<keystroke>` (`key:down`, `key:cmd-k`); a drag as `down:<x>:<y>`, `drag:<x>:<y>` (the
            // pointer there, pressed) and `up:<x>:<y>`; `wheel:<x>:<y>:<dy>` the wheel there, `dy`
            // points (up is positive).
            // Asks of the run's own, here only (nothing reaches the core): `fixture:<file>` adds the
            // items in a JSON array; `close:<id>` closes one as done, `reopen:<id>` opens it again.
            if let Some(rest) = page.strip_prefix("fixture:").or_else(|| page.strip_prefix("close:")).or_else(|| page.strip_prefix("reopen:")) {
                let (rest, which) = (rest.to_string(), page.split(':').next().unwrap_or_default().to_string());
                let _ = cx.update(|cx| fixture(&which, &rest, cx));
                cx.background_executor().timer(Duration::from_millis(1200)).await;
                let shot = cx.update_window(last, |_, window, _| window.render_to_image());
                if let Ok(Ok(img)) = shot {
                    let path = format!("{dir}/{i:02}-{}.png", page.replace([':', '/'], "_"));
                    let _ = img.save(&path);
                    eprintln!("shot: {path}");
                }
                continue;
            }
            // `theme:<system|light|dark>`: the theme's appearance that, as Settings sets it (kept
            // here only).
            if let Some(a) = page.strip_prefix("theme:") {
                let a = match a {
                    "light" => crate::theme::Appearance::Light,
                    "dark" => crate::theme::Appearance::Dark,
                    _ => crate::theme::Appearance::System,
                };
                let _ = cx.update(|cx| {
                    let mut t = crate::theme::Held::theme(cx);
                    t.appearance = a;
                    crate::theme::Held::set(t, cx);
                });
                cx.background_executor().timer(Duration::from_millis(1200)).await;
                continue;
            }
            // `preset:<key>`: both sides of the theme that preset's, as Settings picks it (kept here
            // only).
            if let Some(k) = page.strip_prefix("preset:") {
                let k = k.to_string();
                let _ = cx.update(|cx| {
                    let t = crate::theme::preset_theme(&k, &crate::theme::Held::theme(cx));
                    crate::theme::Held::set(t, cx);
                });
                cx.background_executor().timer(Duration::from_millis(1200)).await;
                continue;
            }
            for (step, pressed) in [("down:", true), ("drag:", true), ("up:", false)] {
                let Some(rest) = page.strip_prefix(step) else { continue };
                let mut xy = rest.split(':').map(|v| v.parse::<f32>().unwrap_or(0.));
                let at = gpui::point(gpui::px(xy.next().unwrap_or(0.)), gpui::px(xy.next().unwrap_or(0.)));
                let _ = cx.update_window(last, move |_, window, cx| {
                    let button = pressed.then_some(gpui::MouseButton::Left);
                    window.dispatch_event(gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent { position: at, pressed_button: button, ..Default::default() }), cx);
                    match step {
                        "down:" => window.dispatch_event(gpui::PlatformInput::MouseDown(gpui::MouseDownEvent { button: gpui::MouseButton::Left, position: at, click_count: 1, ..Default::default() }), cx),
                        "up:" => window.dispatch_event(gpui::PlatformInput::MouseUp(gpui::MouseUpEvent { button: gpui::MouseButton::Left, position: at, click_count: 1, ..Default::default() }), cx),
                        _ => Default::default(),
                    };
                });
            }
            // `ax:<name>`: the window last shot's accessibility tree as AppKit asks for it (as
            // VoiceOver would), saved as JSON.
            if let Some(name) = page.strip_prefix("ax:") {
                let _ = cx.update_window(last, |_, window, _| {
                    if let Some(w) = crate::platform::appkit::ns_window(window)
                        && let Some(v) = w.contentView()
                    {
                        // SAFETY: the window's live content view, on the main thread.
                        let _: *mut objc2::runtime::AnyObject = unsafe { objc2::msg_send![&*v, accessibilityChildren] };
                    }
                    window.refresh();
                });
                cx.background_executor().timer(Duration::from_millis(600)).await;
                let path = format!("{dir}/ax-{name}.json");
                let _ = cx.update_window(last, move |_, window, _| {
                    let tree = window.debug_a11y_tree_json().unwrap_or_default();
                    let _ = std::fs::write(&path, tree);
                    eprintln!("ax: {path}");
                });
                continue;
            }
            if let Some(rest) = page.strip_prefix("click:").or_else(|| page.strip_prefix("dbl:")).or_else(|| page.strip_prefix("key:")).or_else(|| page.strip_prefix("hover:")).or_else(|| page.strip_prefix("down:")).or_else(|| page.strip_prefix("drag:")).or_else(|| page.strip_prefix("up:")).or_else(|| page.strip_prefix("wheel:")) {
                let rest = rest.to_string();
                let click = page.starts_with("click:") || page.starts_with("dbl:");
                let hover = page.starts_with("hover:") || page.starts_with("wheel:");
                let wheel = page.starts_with("wheel:");
                let pressing = ["down:", "drag:", "up:"].iter().any(|p| page.starts_with(p));
                let presses = if page.starts_with("dbl:") { 2 } else { 1 };
                // The composer's own steps, from outside its window (`key:hotkey…`, `key:nsc:…`).
                if let Some(app) = page.strip_prefix("key:hotkey") {
                    let app = app.strip_prefix('-').map(str::to_string);
                    std::thread::spawn(move || hotkey(app.as_deref()));
                    cx.background_executor().timer(Duration::from_millis(2500)).await;
                }
                if let Some(what) = page.strip_prefix("key:nsc:") {
                    let what = what.to_string();
                    let _ = cx.update(|cx| ns_composer(&what, cx));
                }
                let _ = cx.update_window(last, move |_, window, cx| {
                    if pressing {
                        return;
                    }
                    if click || hover {
                        let mut xy = rest.split(':').map(|v| v.parse::<f32>().unwrap_or(0.));
                        let at = gpui::point(gpui::px(xy.next().unwrap_or(0.)), gpui::px(xy.next().unwrap_or(0.)));
                        window.dispatch_event(gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent { position: at, ..Default::default() }), cx);
                        if wheel {
                            let dy = xy.next().unwrap_or(0.);
                            let delta = gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(dy)));
                            window.dispatch_event(gpui::PlatformInput::Scroll(gpui::ScrollEvent { position: at, delta, ..Default::default() }), cx);
                        }
                        if hover {
                            return;
                        }
                        for n in 1..=presses {
                            window.dispatch_event(gpui::PlatformInput::MouseDown(gpui::MouseDownEvent { button: gpui::MouseButton::Left, position: at, click_count: n, ..Default::default() }), cx);
                            window.dispatch_event(gpui::PlatformInput::MouseUp(gpui::MouseUpEvent { button: gpui::MouseButton::Left, position: at, click_count: n, ..Default::default() }), cx);
                        }
                    } else {
                        // `key:clip-<png|tiff|file|mixed>:<path>`: the pasteboard holds that file as a
                        // picture's data (PNG, TIFF), as a copied file, or as words and a PNG,
                        // set the moment before the next step pastes it.
                        if let Some(spec) = rest.strip_prefix("clip-") {
                            let (how, path) = spec.split_once(':').unwrap_or((spec, ""));
                            clip(how, path);
                            return;
                        }
                        // `key:ns-<text>`, `key:nscmd-<letter>`, `key:nsclick-<x>-<y>`: real AppKit events
                        // posted to the app's queue, as the keyboard and mouse send them (through the
                        // menu's keys, the window and its first responder).
                        if let Some(text) = rest.strip_prefix("ns-") {
                            ns_keys(text, false);
                            return;
                        }
                        if let Some(text) = rest.strip_prefix("nscmd-") {
                            ns_keys(text, true);
                            return;
                        }
                        // `key:nsv:<what>:…`: the same, to the window last shot (the viewer's, after
                        // `viewer`): `click:<x>:<y>`, `dbl:<x>:<y>`, `drag:<x>:<y>:<x2>:<y2>`,
                        // `pinch:<x>:<y>:<by>` (a trackpad's magnify, `by` in all), `wheel:<x>:<y>:<dy>`
                        // and `cmdwheel:<x>:<y>:<dy>` (pixels, ⌘ held for the second), and
                        // `key:<escape|left|right|space>`.
                        if let Some(what) = rest.strip_prefix("nsv:") {
                            ns_to(window, what);
                            return;
                        }
                        // `key:hotkey-<app>`: that app brought to the front, then the composer's key
                        // pressed as the keyboard sends it, through the system (`key:hotkey` alone:
                        // with whatever is in front).
                        if rest.starts_with("hotkey") {
                            return;
                        }
                        // `key:nsc:<what>`: real AppKit input to the composer, without the app taking
                        // the front: `text:<words>`, `key:<enter|cmd-enter|tab|up|down|escape|cmd-v|cmd-w>`,
                        // `click:<x>:<y>`; `away` clicks the main window.
                        if rest.starts_with("nsc:") {
                            return;
                        }
                        if let Some(at) = rest.strip_prefix("nsclick-") {
                            let mut xy = at.split('-').map(|v| v.parse::<f64>().unwrap_or(0.));
                            ns_click(xy.next().unwrap_or(0.), xy.next().unwrap_or(0.));
                            return;
                        }
                        // `key:paste`: Edit ▸ Paste, as the menu sends it (⌘V is the menu's key).
                        if rest == "paste" {
                            window.dispatch_action(Box::new(ui_sdk::native::text_field::Paste), cx);
                            return;
                        }
                        let k = gpui::Keystroke::parse(Box::leak(rest.into_boxed_str())).map_err(|_| ());
                        if let Ok(k) = k {
                            // Down, then up: a focused button's press is on the key's release.
                            window.dispatch_keystroke(k.clone(), cx);
                            window.dispatch_event(gpui::PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke: k }), cx);
                        }
                    }
                });
                cx.background_executor().timer(Duration::from_millis(1200)).await;
                if page.starts_with("key:hotkey") || page.starts_with("key:nsc:") {
                    // Where the composer stands, and who has the front.
                    let up = cx.update(|cx| crate::composer::window(cx));
                    let front = objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication().and_then(|a| a.localizedName()).map(|n| n.to_string()).unwrap_or_default();
                    let active = objc2_app_kit::NSRunningApplication::currentApplication().isActive();
                    eprintln!("composer: {} front: {front} active: {active}", if up.is_some() { "up" } else { "closed" });
                    if let Some(w) = up {
                        last = w;
                    }
                }
                let shot = cx.update_window(last, |_, window, cx| {
                    // Where the focus went, as the key contexts down to it.
                    let at: Vec<String> = window.context_stack().iter().map(|c| format!("{c:?}")).collect();
                    // And AppKit's first responder, which the keyboard's keys go to.
                    let responder = crate::platform::appkit::ns_window(window).and_then(|w| w.firstResponder()).map(|r| r.class().name().to_string_lossy().into_owned()).unwrap_or_default();
                    eprintln!("focus: {:?} {} [{responder}]", window.focused(cx), at.join(" > "));
                    window.render_to_image()
                });
                if let Ok(Ok(img)) = shot {
                    let path = format!("{dir}/{i:02}-{}.png", page.replace([':', '/'], "_"));
                    let _ = img.save(&path);
                    eprintln!("shot: {path}");
                }
                continue;
            }
            // The shell's own pages: `palette`, `shortcuts`, `settings:<section>`, `narrow:<space>`
            // (the window 600 wide), `wide:<space>` (back to 1240).
            let mut shoot = window;
            let _ = cx.update(|cx| {
                crate::shell::Shell::update(cx, |s| {
                    s.finding = false;
                    s.shortcuts = false;
                })
            });
            if page == "palette" || page == "shortcuts" {
                let p = page.clone();
                let _ = cx.update(|cx| crate::shell::Shell::update(cx, |s| if p == "palette" { s.finding = true } else { s.shortcuts = true }));
            } else if let Some(section) = page.strip_prefix("settings:") {
                let section = section.to_string();
                let _ = cx.update(|cx| crate::settings::open(&section, cx));
                cx.background_executor().timer(Duration::from_millis(500)).await;
                if let Some(w) = cx.update(|cx| crate::settings::window(cx)) {
                    shoot = w;
                }
            } else if let Some(id) = page.strip_prefix("ask:") {
                let id = id.to_string();
                let _ = cx.update(|cx| crate::asks::window::open(&id, cx));
                cx.background_executor().timer(Duration::from_millis(500)).await;
                if let Some(w) = cx.update(|cx| crate::asks::window::handle(&id, cx)) {
                    shoot = w;
                }
            } else if page == "composer" || page.starts_with("composer:") {
                // `composer`, `composer:<space>` (aimed there): its window, which steps after it go
                // to, opened as ⌘/ or Tab in ⌘K opens it.
                let aim = page.strip_prefix("composer:").map(str::to_string);
                let _ = cx.update(|cx| crate::composer::toggle(aim, cx));
                cx.background_executor().timer(Duration::from_millis(800)).await;
                if let Some(w) = cx.update(|cx| crate::composer::window(cx)) {
                    shoot = w;
                }
            } else if page == "viewer" {
                // `viewer`: the full screen's window, which steps after it go to; `main` the main
                // window again.
                if let Some(w) = cx.update(|cx| crate::viewer::handle(cx)) {
                    shoot = w;
                }
            } else if let Some(path) = page.strip_prefix("read:") {
                // `read:<file>`: its words as Markdown in a reading window, as More opens one.
                let text = std::fs::read_to_string(path).unwrap_or_default();
                let _ = cx.update(|cx| crate::chat_platform::read("Reading", &text, cx));
                cx.background_executor().timer(Duration::from_millis(500)).await;
                if let Some(w) = cx.update(|cx| cx.windows().into_iter().last()) {
                    shoot = w;
                }
            } else if let Some(rest) = page.strip_prefix("narrow:").or_else(|| page.strip_prefix("wide:")).or_else(|| page.strip_prefix("width").and_then(|r| r.split_once(':').map(|(_, sp)| sp))) {
                // `width<px>:<space>`: the window that wide.
                let w = if page.starts_with("narrow:") { 600. } else if let Some(n) = page.strip_prefix("width").and_then(|r| r.split(':').next()).and_then(|n| n.parse::<f32>().ok()) { n } else { 1240. };
                let _ = cx.update_window(window, |_, window, _| window.resize(gpui::size(gpui::px(w), gpui::px(800.))));
                let r = rest.to_string();
                let _ = cx.update(|cx| Nav::open(Page::Space(r), cx));
            }
            let special = page == "viewer" || page == "composer" || page.starts_with("composer:") || page == "main" || page == "palette" || page == "shortcuts" || page.starts_with("settings:") || page.starts_with("ask:") || page.starts_with("read:") || page.starts_with("narrow:") || page.starts_with("wide:") || page.starts_with("width");
            let to = match page.strip_prefix("thread:") {
                Some(t) => {
                    let t = t.to_string();
                    let space = cx
                        .update(|cx| {
                            let m = model(cx).read(cx);
                            m.brain.threads.get(&t).map(|th| crate::derive::space_of(&m.brain, th).to_string()).unwrap_or_else(|| "home".into())
                        });
                    Page::Thread(t, space)
                }
                None => Page::Space(page.split('@').next().unwrap_or(page).to_string()),
            };
            // `<space>@<seq>`: the space's chat at that line, as a link to it opens it.
            let at = page.split_once('@').and_then(|(_, seq)| seq.parse::<u64>().ok());
            if !special {
                let _ = cx.update(|cx| match (&to, at) {
                    (Page::Space(space), Some(seq)) => Nav::open_at(space.clone(), Some(seq), cx),
                    _ => Nav::open(to, cx),
                });
            }
            cx.background_executor().timer(Duration::from_millis(2500)).await;
            last = shoot;
            let shot = cx.update_window(shoot, |_, window, _| window.render_to_image());
            match shot {
                Ok(Ok(img)) => {
                    let path = format!("{dir}/{i:02}-{}.png", page.replace([':', '/'], "_"));
                    let _ = img.save(&path);
                    eprintln!("shot: {path}");
                }
                Ok(Err(e)) => eprintln!("shot failed: {e}"),
                Err(e) => eprintln!("shot failed: {e}"),
            }
        }
        // The desktop extension's screenshot of the main window, as the agent gets it.
        let snap = cx.update(crate::platform::snapshot::window_shot).await;
        match snap.map(|b64| base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64)) {
            Ok(Ok(jpeg)) => {
                let path = format!("{dir}/window.jpg");
                let _ = std::fs::write(&path, jpeg);
                eprintln!("shot: {path}");
            }
            Ok(Err(e)) => eprintln!("window shot failed: {e}"),
            Err(e) => eprintln!("window shot failed: {e}"),
        }
        if std::env::var("SWITCH_GPUI_QUIT").is_ok() {
            let _ = cx.update(|cx| cx.quit());
        }
    })
    .detach();
}

/// `$SWITCH_GPUI_TOUR`: once the brain is in, opens spaces one after another (each twice: a first
/// visit, then a return) and times each from the ask to the frame after it, then scrolls Home's
/// chat a frame at a time through the window's own event path and times the frames; prints them.
pub fn tour(window: AnyWindowHandle, cx: &mut App) {
    if std::env::var("SWITCH_GPUI_TOUR").is_err() {
        return;
    }
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Instant;
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor().timer(Duration::from_millis(200)).await;
            if cx.update(|cx| model(cx).read(cx).brain.ready) {
                break;
            }
        }
        cx.background_executor().timer(Duration::from_millis(1500)).await;
        let spaces: Vec<String> = cx.update(|cx| {
            let m = model(cx).read(cx);
            let mut all: Vec<String> = m.brain.spaces.values().filter(|s| !s.archived && s.id != "home").map(|s| s.id.clone()).collect();
            all.sort();
            all.into_iter().take(10).collect()
        });
        let times: Rc<RefCell<Vec<(String, bool, f64)>>> = Rc::default();
        for pass in [true, false] {
            for s in spaces.iter().chain(std::iter::once(&"home".to_string())) {
                let (times, s2) = (times.clone(), s.clone());
                let _ = cx.update_window(window, move |_, window, cx| {
                    let t0 = Instant::now();
                    Nav::open(Page::Space(s2.clone()), cx);
                    window.on_next_frame(move |_, _| times.borrow_mut().push((s2, pass, t0.elapsed().as_secs_f64() * 1000.)));
                    window.refresh();
                });
                cx.background_executor().timer(Duration::from_millis(500)).await;
            }
        }
        let stat = |v: &mut Vec<f64>| {
            v.sort_by(f64::total_cmp);
            (v[v.len() / 2], v[v.len() - 1])
        };
        for pass in [true, false] {
            let mut v: Vec<f64> = times.borrow().iter().filter(|t| t.1 == pass).map(|t| t.2).collect();
            let (med, max) = stat(&mut v);
            eprintln!("tour: switch ({}) median {med:.1} ms, max {max:.1} ms over {}", if pass { "first visit" } else { "return" }, v.len());
        }
        // Scrolling: one wheel step a frame, up then back down. Each step goes as the last frame is
        // drawn, not on a timer of its own, which would beat against the display's refresh and miss
        // one frame in about 25.
        let frames: Rc<RefCell<Vec<Instant>>> = Rc::default();
        // `$SWITCH_GPUI_TOUR` a number: that many steps each way, far enough for older pages to land.
        let steps: usize = std::env::var("SWITCH_GPUI_TOUR").ok().and_then(|v| v.parse().ok()).unwrap_or(90);
        for dir in [1., -1.] {
            for _ in 0..steps {
                let (tx, rx) = futures::channel::oneshot::channel::<()>();
                let f = frames.clone();
                let _ = cx.update_window(window, move |_, window, cx| {
                    let size = window.viewport_size();
                    let at = gpui::point(size.width * 0.6, size.height * 0.4);
                    window.dispatch_event(
                        gpui::PlatformInput::Scroll(gpui::ScrollEvent { position: at, delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(40. * dir))), ..Default::default() }),
                        cx,
                    );
                    window.on_next_frame(move |_, _| {
                        f.borrow_mut().push(Instant::now());
                        let _ = tx.send(());
                    });
                });
                let _ = rx.await;
            }
        }
        let f = frames.borrow();
        let mut gaps: Vec<f64> = f.windows(2).map(|w| (w[1] - w[0]).as_secs_f64() * 1000.).collect();
        let long = gaps.iter().filter(|g| **g > 25.).count();
        let (med, max) = stat(&mut gaps);
        eprintln!("tour: scroll frames {} median {med:.1} ms, max {max:.1} ms, {long} over 25 ms", f.len());
        let rss = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default();
        eprintln!("tour: rss {} MB", rss.trim().parse::<f64>().unwrap_or(0.) / 1024.);
        let _ = cx.update(|cx| cx.quit());
    })
    .detach();
}

/// `$SWITCH_GPUI_WHEEL=x,y,px,seconds`: once the brain is in, the window `$SWITCH_GPUI_SIZE` (w,h)
/// on Home, the wheel turned a step a frame at `x`,`y` (fractions of the window) by `px`, turning
/// back each second, for `seconds` (`$SWITCH_GPUI_AT` a line to open Home's chat at): for watching a web view keep to its row as it scrolls.
pub fn wheel(window: AnyWindowHandle, cx: &mut App) {
    let Ok(spec) = std::env::var("SWITCH_GPUI_WHEEL") else { return };
    let n: Vec<f32> = spec.split(',').filter_map(|x| x.trim().parse().ok()).collect();
    let [x, y, step, secs] = n[..] else { return };
    let size: Vec<f32> = std::env::var("SWITCH_GPUI_SIZE").unwrap_or_default().split(',').filter_map(|x| x.trim().parse().ok()).collect();
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor().timer(Duration::from_millis(200)).await;
            if cx.update(|cx| model(cx).read(cx).brain.ready) {
                break;
            }
        }
        if let [w, h] = size[..] {
            let _ = cx.update_window(window, |_, window, _| window.resize(gpui::size(gpui::px(w), gpui::px(h))));
        }
        // `$SWITCH_GPUI_AT`: Home's chat opened at that line.
        let at = std::env::var("SWITCH_GPUI_AT").ok().and_then(|a| a.parse().ok());
        let _ = cx.update(|cx| Nav::open_at("home".into(), at, cx));
        cx.background_executor().timer(Duration::from_millis(6000)).await;
        let frames = (secs * 60.) as usize;
        for i in 0..frames {
            let dir = if (i / 60) % 2 == 0 { 1. } else { -1. };
            let _ = cx.update_window(window, move |_, window, cx| {
                let s = window.viewport_size();
                let at = gpui::point(s.width * x, s.height * y);
                window.dispatch_event(gpui::PlatformInput::Scroll(gpui::ScrollEvent { position: at, delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(0.), gpui::px(step * dir))), ..Default::default() }), cx);
            });
            cx.background_executor().timer(Duration::from_millis(16)).await;
        }
    })
    .detach();
}

/// A run's own asks, in this copy's brain only.
fn fixture(which: &str, arg: &str, cx: &mut App) {
    use crate::items::ActionItem;
    model(cx).update(cx, |m, cx| {
        let items = &mut m.brain.items;
        match which {
            "fixture" => {
                let raw: Vec<serde_json::Value> = std::fs::read_to_string(arg).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
                let now = crate::time::now_ms();
                for r in &raw {
                    let at = r.get("at").and_then(serde_json::Value::as_f64).unwrap_or(now);
                    let Some(item) = ActionItem::of(r, at) else {
                        eprintln!("shot: fixture item didn't read");
                        continue;
                    };
                    if item.is_open() {
                        items.open.insert(item.id.clone(), item);
                    } else {
                        items.closed.insert(0, item);
                    }
                }
            }
            "close" => {
                if let Some(mut item) = items.open.remove(arg) {
                    item.status = "done".into();
                    items.closed.insert(0, item);
                }
            }
            _ => {
                if let Some(n) = items.closed.iter().position(|c| c.id == arg) {
                    let mut item = items.closed.remove(n);
                    item.status = "open".into();
                    items.open.insert(item.id.clone(), item);
                }
            }
        }
        m.brain.version += 1;
        m.refresh();
        cx.notify();
    });
}

/// Puts a file on the general pasteboard for a paste to find, as `key:clip-…` asks.
fn clip(how: &str, path: &str) {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSData, NSString, NSURL};
    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    let bytes = std::fs::read(path).unwrap_or_default();
    let data = NSData::with_bytes(&bytes);
    match how {
        "png" => drop(pb.setData_forType(Some(&data), &NSString::from_str("public.png"))),
        "tiff" => drop(pb.setData_forType(Some(&data), &NSString::from_str("public.tiff"))),
        "mixed" => {
            pb.setString_forType(&NSString::from_str("words with it"), &NSString::from_str("public.utf8-plain-text"));
            pb.setData_forType(Some(&data), &NSString::from_str("public.png"));
        }
        _ => {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            if let Some(s) = url.absoluteString() {
                pb.setString_forType(&s, &NSString::from_str("public.file-url"));
            }
        }
    }
}

/// The app's main window, made key so the keyboard's events reach it, as a click on it would.
fn ns_window() -> Option<objc2::rc::Retained<objc2_app_kit::NSWindow>> {
    let mtm = objc2_foundation::MainThreadMarker::new()?;
    let app = objc2_app_kit::NSApplication::sharedApplication(mtm);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    let w = app.windows().iter().find(|w| w.isVisible() && w.title().to_string() == "Switchboard")?;
    w.makeKeyAndOrderFront(None);
    Some(w)
}

/// Posts keystrokes for `text` (letters and spaces) as the keyboard would, ⌘ held if `cmd`.
fn ns_keys(text: &str, cmd: bool) {
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{NSPoint, NSString};
    let Some(w) = ns_window() else { return };
    let mtm = objc2_foundation::MainThreadMarker::new().expect("main thread");
    let app = NSApplication::sharedApplication(mtm);
    const CODES: &str = "asdfhgzxcv bqweryt123465=97-80]ou[ip lj'k;\\,/nm.";
    for ch in text.chars() {
        let code = if ch == ' ' { 49 } else { CODES.find(ch.to_ascii_lowercase()).unwrap_or(0) as u16 };
        let flags = if cmd { NSEventModifierFlags::Command } else { NSEventModifierFlags::empty() };
        let c = NSString::from_str(&ch.to_string());
        for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
            let e: Option<objc2::rc::Retained<NSEvent>> = unsafe {
                objc2::msg_send![objc2::class!(NSEvent), keyEventWithType: kind, location: NSPoint::new(0., 0.), modifierFlags: flags, timestamp: 0f64, windowNumber: w.windowNumber(), context: std::ptr::null::<objc2::runtime::AnyObject>(), characters: &*c, charactersIgnoringModifiers: &*c, isARepeat: false, keyCode: code]
            };
            if let Some(e) = e {
                app.postEvent_atStart(&e, false);
            }
        }
    }
}

/// Posts a click at (`x`, `y`) in the window's points, from its top left, as the mouse would.
fn ns_click(x: f64, y: f64) {
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::NSPoint;
    let Some(w) = ns_window() else { return };
    let mtm = objc2_foundation::MainThreadMarker::new().expect("main thread");
    let app = NSApplication::sharedApplication(mtm);
    let h = w.contentRectForFrameRect(w.frame()).size.height;
    let at = NSPoint::new(x, h - y);
    for kind in [NSEventType::LeftMouseDown, NSEventType::LeftMouseUp] {
        let e: Option<objc2::rc::Retained<NSEvent>> = unsafe {
            objc2::msg_send![objc2::class!(NSEvent), mouseEventWithType: kind, location: at, modifierFlags: NSEventModifierFlags::empty(), timestamp: 0f64, windowNumber: w.windowNumber(), context: std::ptr::null::<objc2::runtime::AnyObject>(), eventNumber: 0isize, clickCount: 1isize, pressure: 1f32]
        };
        if let Some(e) = e {
            app.postEvent_atStart(&e, false);
        }
    }
}

/// Posts real AppKit input to `window` for `key:nsv:…`, as the mouse, the trackpad and the keyboard
/// send it: mouse events made for the window; the trackpad's magnify and the wheel as Quartz events
/// (a magnify can't be made otherwise), turned into AppKit's and put in the app's queue.
fn ns_to(window: &gpui::Window, what: &str) {
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{NSPoint, NSString};
    type Ref = *mut std::ffi::c_void;
    unsafe extern "C" {
        fn CGEventCreate(source: Ref) -> Ref;
        fn CGEventCreateScrollWheelEvent2(source: Ref, units: u32, count: u32, w1: i32, w2: i32, w3: i32) -> Ref;
        fn CGEventSetType(e: Ref, t: u32);
        fn CGEventSetIntegerValueField(e: Ref, field: u32, v: i64);
        fn CGEventSetDoubleValueField(e: Ref, field: u32, v: f64);
        fn CGEventSetLocation(e: Ref, at: objc2_core_foundation::CGPoint);
        fn CGEventSetFlags(e: Ref, flags: u64);
        fn CFRelease(r: Ref);
    }
    let Some(mtm) = objc2_foundation::MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    let Some(w) = crate::platform::appkit::ns_window(window) else { return };
    w.makeKeyAndOrderFront(None);
    let n = w.windowNumber();
    let frame = w.frame();
    let h = w.contentRectForFrameRect(frame).size.height;
    let parts: Vec<&str> = what.split(':').collect();
    let num = |i: usize| parts.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.);
    let (x, y) = (num(1), num(2));
    let local = |x: f64, y: f64| NSPoint::new(x, h - y);
    let post = |e: Option<objc2::rc::Retained<NSEvent>>| {
        if let Some(e) = e {
            app.postEvent_atStart(&e, false);
        }
    };
    let mouse = |kind: NSEventType, at: NSPoint, clicks: isize| -> Option<objc2::rc::Retained<NSEvent>> {
        unsafe {
            objc2::msg_send![objc2::class!(NSEvent), mouseEventWithType: kind, location: at, modifierFlags: NSEventModifierFlags::empty(), timestamp: 0f64, windowNumber: n, context: std::ptr::null::<objc2::runtime::AnyObject>(), eventNumber: 0isize, clickCount: clicks, pressure: 1f32]
        }
    };
    // A Quartz event at (x, y) in the window, as the screen counts from its top left, for the
    // window.
    let quartz = |e: Ref| -> Option<objc2::rc::Retained<NSEvent>> {
        let screen = w.screen().map(|s| s.frame()).unwrap_or(frame);
        let at = objc2_core_foundation::CGPoint::new(frame.origin.x + x, screen.size.height - (frame.origin.y + h) + y);
        unsafe {
            CGEventSetLocation(e, at);
            // Quartz's window field (51), which AppKit reads as the event's window, and field 58
            // set, without which AppKit takes the point as the window's corner rather than from
            // the location (found by trying each).
            CGEventSetIntegerValueField(e, 51, n as i64);
            CGEventSetDoubleValueField(e, 58, 1.);
            let ns: Option<objc2::rc::Retained<NSEvent>> = objc2::msg_send![objc2::class!(NSEvent), eventWithCGEvent: e];
            CFRelease(e);
            ns
        }
    };
    match parts.first().copied().unwrap_or_default() {
        "click" => {
            post(mouse(NSEventType::LeftMouseDown, local(x, y), 1));
            post(mouse(NSEventType::LeftMouseUp, local(x, y), 1));
        }
        "dbl" => {
            for clicks in [1, 2] {
                post(mouse(NSEventType::LeftMouseDown, local(x, y), clicks));
                post(mouse(NSEventType::LeftMouseUp, local(x, y), clicks));
            }
        }
        "drag" => {
            let (x2, y2) = (num(3), num(4));
            post(mouse(NSEventType::LeftMouseDown, local(x, y), 1));
            for i in 1..=10 {
                let t = i as f64 / 10.;
                post(mouse(NSEventType::LeftMouseDragged, local(x + (x2 - x) * t, y + (y2 - y) * t), 1));
            }
            post(mouse(NSEventType::LeftMouseUp, local(x2, y2), 1));
        }
        "pinch" => {
            // Began, five changes making `by` in all, ended: Quartz's gesture event (type 29), its
            // HID kind a zoom (field 110 = 8), the change (113) and the phase (132).
            let by = num(3);
            for (phase, d) in [(1, 0.)].into_iter().chain((0..5).map(|_| (2, by / 5.))).chain([(4, 0.)]) {
                let e = unsafe { CGEventCreate(std::ptr::null_mut()) };
                unsafe {
                    CGEventSetType(e, 29);
                    CGEventSetIntegerValueField(e, 110, 8);
                    CGEventSetDoubleValueField(e, 113, d);
                    CGEventSetIntegerValueField(e, 132, phase);
                }
                post(quartz(e));
            }
        }
        wheel @ ("wheel" | "cmdwheel") => {
            let e = unsafe { CGEventCreateScrollWheelEvent2(std::ptr::null_mut(), 0, 1, num(3) as i32, 0, 0) };
            if wheel == "cmdwheel" {
                // kCGEventFlagMaskCommand.
                unsafe { CGEventSetFlags(e, 1 << 20) };
            }
            post(quartz(e));
        }
        "key" => {
            let (code, ch): (u16, String) = match parts.get(1).copied().unwrap_or_default() {
                "escape" => (53, "\u{1b}".into()),
                "left" => (123, "\u{f702}".into()),
                "right" => (124, "\u{f703}".into()),
                _ => (49, " ".into()),
            };
            let c = NSString::from_str(&ch);
            for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
                let e: Option<objc2::rc::Retained<NSEvent>> = unsafe {
                    objc2::msg_send![objc2::class!(NSEvent), keyEventWithType: kind, location: NSPoint::new(0., 0.), modifierFlags: NSEventModifierFlags::empty(), timestamp: 0f64, windowNumber: n, context: std::ptr::null::<objc2::runtime::AnyObject>(), characters: &*c, charactersIgnoringModifiers: &*c, isARepeat: false, keyCode: code]
                };
                post(e);
            }
        }
        _ => {}
    }
}

/// The composer's key, as the keyboard sends it: a Quartz event posted to the system, which takes
/// it for the hotkey before any app; `app` (a name) brought to the front first.
fn hotkey(app: Option<&str>) {
    type Ref = *mut std::ffi::c_void;
    unsafe extern "C" {
        fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> Ref;
        fn CGEventSetFlags(e: Ref, flags: u64);
        fn CGEventPost(tap: u32, e: Ref);
        fn CFRelease(r: Ref);
    }
    if let Some(app) = app {
        let _ = std::process::Command::new("open").args(["-a", app]).status();
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }
    let Ok(k) = gpui::Keystroke::parse(crate::platform::hotkey::KEY) else { return };
    // The key's place on an ANSI keyboard, and ⌘'s flag.
    const CODES: &str = "asdfhgzxcv bqweryt123465=97-80]ou[ip lj'k;\\,/nm.";
    let code = CODES.find(k.key.as_str()).unwrap_or(44) as u16;
    for down in [true, false] {
        // SAFETY: a keyboard event made here, posted once at the HID tap and released.
        unsafe {
            let e = CGEventCreateKeyboardEvent(std::ptr::null_mut(), code, down);
            if k.modifiers.platform {
                CGEventSetFlags(e, 1 << 20);
            }
            CGEventPost(0, e);
            CFRelease(e);
        }
    }
}

/// Real AppKit input to the composer's window, put in the app's queue without the app taking the
/// front (`key:nsc:…`).
fn ns_composer(what: &str, cx: &mut gpui::App) {
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{NSPoint, NSString};
    let Some(mtm) = objc2_foundation::MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    if what == "away" {
        // A click on the main window: it takes the keyboard, as a click there would.
        if let Some(main) = crate::platform::lifecycle::main_window(cx) {
            let _ = main.update(cx, |_, window, _| crate::platform::appkit::show(window));
        }
        return;
    }
    let Some(handle) = crate::composer::window(cx) else { return };
    let Ok(Some(w)) = handle.update(cx, |_, window, _| crate::platform::appkit::ns_window(window)) else { return };
    let n = w.windowNumber();
    let h = w.contentRectForFrameRect(w.frame()).size.height;
    let post = |e: Option<objc2::rc::Retained<NSEvent>>| {
        if let Some(e) = e {
            app.postEvent_atStart(&e, false);
        }
    };
    let key = |code: u16, ch: &str, flags: NSEventModifierFlags| {
        let c = NSString::from_str(ch);
        for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
            post(unsafe {
                objc2::msg_send![objc2::class!(NSEvent), keyEventWithType: kind, location: NSPoint::new(0., 0.), modifierFlags: flags, timestamp: 0f64, windowNumber: n, context: std::ptr::null::<objc2::runtime::AnyObject>(), characters: &*c, charactersIgnoringModifiers: &*c, isARepeat: false, keyCode: code]
            });
        }
    };
    let parts: Vec<&str> = what.splitn(2, ':').collect();
    let arg = parts.get(1).copied().unwrap_or_default();
    const CODES: &str = "asdfhgzxcv bqweryt123465=97-80]ou[ip lj'k;\\,/nm.";
    match parts.first().copied().unwrap_or_default() {
        "text" => {
            for ch in arg.chars() {
                let shifted = ch == '#' || ch.is_ascii_uppercase();
                let code = match ch {
                    ' ' => 49,
                    '#' => 20,
                    _ => CODES.find(ch.to_ascii_lowercase()).unwrap_or(0) as u16,
                };
                key(code, &ch.to_string(), if shifted { NSEventModifierFlags::Shift } else { NSEventModifierFlags::empty() });
            }
        }
        "key" => {
            let (code, ch, flags) = match arg {
                "enter" => (36, "\r", NSEventModifierFlags::empty()),
                "cmd-enter" => (36, "\r", NSEventModifierFlags::Command),
                "tab" => (48, "\t", NSEventModifierFlags::empty()),
                "up" => (126, "\u{f700}", NSEventModifierFlags::empty()),
                "down" => (125, "\u{f701}", NSEventModifierFlags::empty()),
                "escape" => (53, "\u{1b}", NSEventModifierFlags::empty()),
                "cmd-v" => (9, "v", NSEventModifierFlags::Command),
                "cmd-w" => (13, "w", NSEventModifierFlags::Command),
                _ => (51, "\u{7f}", NSEventModifierFlags::empty()),
            };
            key(code, ch, flags);
        }
        "click" => {
            let mut xy = arg.split(':').map(|v| v.parse::<f64>().unwrap_or(0.));
            let at = NSPoint::new(xy.next().unwrap_or(0.), h - xy.next().unwrap_or(0.));
            for kind in [NSEventType::LeftMouseDown, NSEventType::LeftMouseUp] {
                post(unsafe {
                    objc2::msg_send![objc2::class!(NSEvent), mouseEventWithType: kind, location: at, modifierFlags: NSEventModifierFlags::empty(), timestamp: 0f64, windowNumber: n, context: std::ptr::null::<objc2::runtime::AnyObject>(), eventNumber: 0isize, clickCount: 1isize, pressure: 1f32]
                });
            }
        }
        _ => {}
    }
}
