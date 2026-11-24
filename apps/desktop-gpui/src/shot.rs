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
                        let k = gpui::Keystroke::parse(Box::leak(rest.into_boxed_str())).map_err(|_| ());
                        if let Ok(k) = k {
                            // Down, then up: a focused button's press is on the key's release.
                            window.dispatch_keystroke(k.clone(), cx);
                            window.dispatch_event(gpui::PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke: k }), cx);
                        }
                    }
                });
                cx.background_executor().timer(Duration::from_millis(1200)).await;
                let shot = cx.update_window(last, |_, window, cx| {
                    // Where the focus went, as the key contexts down to it.
                    let at: Vec<String> = window.context_stack().iter().map(|c| format!("{c:?}")).collect();
                    eprintln!("focus: {:?} {}", window.focused(cx), at.join(" > "));
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
            let special = page == "palette" || page == "shortcuts" || page.starts_with("settings:") || page.starts_with("ask:") || page.starts_with("read:") || page.starts_with("narrow:") || page.starts_with("wide:") || page.starts_with("width");
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
