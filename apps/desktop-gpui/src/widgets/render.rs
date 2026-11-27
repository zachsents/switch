//! Drawing a surface (`@a2ui/react`'s `A2uiSurface`, the desktop's three catalogs): from its
//! `root`, each component by its catalog and name, A2UI's basic catalog (`basic/`), Switch's own
//! (`house/`, `charts/`) and the MCP catalog's McpApp (`page.rs`). Every part is drawn here as a
//! function of its component, where it's drawn (`Ctx`) and the window; what a part keeps between
//! frames (a field's words, a popover's open) is gpui keyed state, under the surface, the
//! component and its place in the data.

use std::rc::Rc;

use gpui::{AnyElement, App, ElementId, Entity, IntoElement, ParentElement, Styled, Window, div};
use serde_json::Value;

use crate::a2ui::{self, BASIC_CATALOG, Child, MCP_CATALOG, SWITCH_CATALOG, Scope, Surface};
use crate::look::Look;
use crate::widgets::host::Host;

/// Where a part is drawn.
#[derive(Clone)]
pub struct Ctx {
    /// The surface's key: `<app>/<name>`, a chat's `#<seq>` after it.
    pub key: Rc<str>,
    pub scope: Scope,
    pub look: Look,
    /// Inside a key (A2UI's Button): a part draws only its words or its glyph.
    pub in_key: bool,
    /// In a widget's own window (`[data-cell]`): the window decides a page's size.
    pub in_window: bool,
    /// Its parent lays its children across (`data-across`): a card rules its right side.
    pub across: bool,
    /// The last of its parent's children: a card draws no rule after it.
    pub last: bool,
    /// In a column with a live picture (a camera and its printer): a Row is the picture's plate.
    pub on_picture: bool,
    /// In a space's widget column, where captions never paint.
    pub in_column: bool,
    /// The surface's whole width, px, when known (charts lay out to it).
    pub width: Option<f32>,
}

impl Ctx {
    pub fn new(key: &str, surface: Rc<Surface>, look: Look) -> Self {
        Ctx {
            key: key.into(),
            scope: Scope::new(surface),
            look,
            in_key: false,
            in_window: false,
            across: false,
            last: true,
            on_picture: false,
            in_column: false,
            width: None,
        }
    }

    /// The extension the surface is a widget of.
    pub fn app(&self) -> &str {
        self.key.split('/').next().unwrap_or_default()
    }

    /// The key the widget's data reloads under (a chat's surface reloads as itself).
    pub fn surface_key(&self) -> String {
        self.key.to_string()
    }

    /// State a part keeps between frames, under its component and place.
    pub fn state<T: 'static>(&self, c: &Value, tag: &str, window: &mut Window, cx: &mut App, init: impl FnOnce(&mut Window, &mut gpui::Context<T>) -> T) -> Entity<T> {
        let id = c.get("id").and_then(Value::as_str).unwrap_or_default();
        window.use_keyed_state(ElementId::Name(format!("a2ui:{}:{}@{}:{}", self.key, id, self.scope.base, tag).into()), cx, init)
    }

    /// A stable id for an element of this part.
    pub fn id(&self, c: &Value, tag: &str) -> ElementId {
        let id = c.get("id").and_then(Value::as_str).unwrap_or_default();
        ElementId::Name(format!("a2ui:{}:{}@{}:{}", self.key, id, self.scope.base, tag).into())
    }

    /// Writes a control's value back to where its property is bound (two-way binding).
    pub fn writer(&self, c: &Value, key: &str) -> Option<impl Fn(Value, &mut App) + 'static> {
        let path = self.scope.bound(c, key)?;
        let surface = self.key.to_string();
        Some(move |value: Value, cx: &mut App| {
            Host::entity(cx).update(cx, |h, cx| h.write(&surface, &path, value, cx));
        })
    }

    /// What pressing a part with this action does (its context resolved as drawn).
    pub fn on_press(&self, action: &Value) -> impl Fn(&mut App) + 'static {
        let key = self.key.to_string();
        let action = action.clone();
        let scope = self.scope.clone();
        move |cx: &mut App| Host::press(&key, a2ui::pressed(&scope, &action), cx)
    }

    /// A child's context: drawn at its own place in the data, `last` and `across` as its parent
    /// lays it.
    pub fn for_child(&self, child: &Child, last: bool, across: bool) -> Ctx {
        let mut c = self.clone();
        c.scope = self.scope.at(&child.base);
        c.last = last;
        c.across = across;
        c
    }

    /// One child drawn.
    pub fn build(&self, child: &Child, window: &mut Window, cx: &mut App) -> AnyElement {
        build(child, self, window, cx)
    }

    /// A child list drawn in order, each told whether it's last and whether its parent lays across.
    pub fn build_all(&self, children: &[Child], across: bool, window: &mut Window, cx: &mut App) -> Vec<AnyElement> {
        let n = children.len();
        children.iter().enumerate().map(|(i, ch)| build(ch, &self.for_child(ch, i + 1 == n, across), window, cx)).collect()
    }

}

/// A component and its name, if the surface has it.
pub fn component<'a>(ctx: &'a Ctx, id: &str) -> Option<(Rc<Value>, String, String)> {
    let c = ctx.scope.surface.component(id)?.clone();
    let name = c.get("component").and_then(Value::as_str).unwrap_or_default().to_string();
    let catalog = ctx.scope.surface.catalog_of(&c).to_string();
    Some((c, name, catalog))
}

/// What a component is drawn as: its catalog's part of that name, else the first catalog that has
/// one (as `build` draws it).
fn part_of(name: &str, catalog: &str) -> &'static str {
    const BASIC: &[&str] = &["Text", "Image", "Icon", "Video", "AudioPlayer", "Row", "Column", "List", "Card", "Tabs", "Modal", "Divider", "Button", "TextField", "CheckBox", "ChoicePicker", "Slider", "DateTimeInput"];
    const HOUSE: &[&str] = &["Line", "Row", "Pick", "Slot", "Field", "Feed", "Gallery", "Title", "Check", "Entry", "Playing", "Document"];
    const CHARTS: &[&str] = &["BarChart", "LineChart", "AreaChart", "Sparkline", "DonutChart", "ScatterChart", "Histogram", "CalendarHeatmap", "Meter"];
    let basic = BASIC.contains(&name);
    let house = HOUSE.contains(&name);
    let chart = CHARTS.contains(&name);
    let page = name == "McpApp";
    let first = match catalog {
        SWITCH_CATALOG if house => Some("house"),
        SWITCH_CATALOG if chart => Some("chart"),
        MCP_CATALOG if page => Some("page"),
        BASIC_CATALOG if basic => Some("basic"),
        _ => None,
    };
    first.unwrap_or(if basic {
        "basic"
    } else if house {
        "house"
    } else if chart {
        "chart"
    } else if page {
        "page"
    } else {
        ""
    })
}

/// The children of a component that are drawn in its place (a Modal's content floats elsewhere;
/// Tabs draw their first tab's child until another is chosen).
fn drawn_children(ctx: &Ctx, c: &Value, name: &str) -> Vec<Child> {
    let mut kids = ctx.scope.children(c, "children");
    kids.extend(["child", "trigger"].iter().filter_map(|k| ctx.scope.child(c, k)));
    if name == "Tabs"
        && let Some(id) = c.pointer("/tabs/0/child").and_then(Value::as_str)
    {
        kids.push(Child { id: id.into(), base: ctx.scope.base.clone() });
    }
    kids
}

/// The words a component draws, as a screen reader names a key by what's in it.
pub fn words_in(ctx: &Ctx, id: &str, depth: usize) -> String {
    let Some((c, name, _)) = component(ctx, id) else { return String::new() };
    if depth > 12 {
        return String::new();
    }
    if name == "Text" {
        return crate::widgets::basic::text::said(&ctx.scope.words(&c, "text"));
    }
    let words: Vec<String> = drawn_children(ctx, &c, &name).iter().map(|ch| words_in(&ctx.for_child(ch, true, false), &ch.id, depth + 1)).filter(|w| !w.is_empty()).collect();
    words.join(" ")
}

/// Whether a component, or one inside it, is a live picture (`[data-column]:has([data-feed])`).
pub fn has_feed(ctx: &Ctx, id: &str, depth: usize) -> bool {
    let Some((c, name, catalog)) = component(ctx, id) else { return false };
    if part_of(&name, &catalog) == "house" && name == "Feed" {
        return true;
    }
    if depth > 12 {
        return false;
    }
    drawn_children(ctx, &c, &name).iter().any(|ch| has_feed(&ctx.for_child(ch, true, false), &ch.id, depth + 1))
}

/// One component drawn by its catalog and name; one a catalog doesn't have draws nothing.
pub fn build(child: &Child, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let Some((c, name, catalog)) = component(ctx, &child.id) else { return div().into_any_element() };
    let drawn = match catalog.as_str() {
        SWITCH_CATALOG => crate::widgets::house::draw(&name, &c, ctx, window, cx).or_else(|| crate::widgets::charts::draw(&name, &c, ctx, window, cx)),
        MCP_CATALOG => crate::widgets::page::draw(&name, &c, ctx, window, cx),
        BASIC_CATALOG => crate::widgets::basic::draw(&name, &c, ctx, window, cx),
        _ => None,
    };
    drawn
        .or_else(|| crate::widgets::basic::draw(&name, &c, ctx, window, cx))
        .or_else(|| crate::widgets::house::draw(&name, &c, ctx, window, cx))
        .or_else(|| crate::widgets::charts::draw(&name, &c, ctx, window, cx))
        .or_else(|| crate::widgets::page::draw(&name, &c, ctx, window, cx))
        .unwrap_or_else(|| div().into_any_element())
}

/// What a surface whose root fills its window (a Document) is called, the window's band naming it.
pub fn fills(ctx: &Ctx) -> Option<String> {
    let (c, name, catalog) = component(ctx, "root")?;
    (part_of(&name, &catalog) == "house" && name == "Document").then(|| ctx.scope.text(&c, "title"))
}

/// A surface drawn from its root.
pub fn surface(ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let root = Child { id: "root".into(), base: String::new() };
    div().flex().flex_col().w_full().child(build(&root, ctx, window, cx)).into_any_element()
}

/// Whether what a surface draws is nothing to show (widget-cell.tsx): no words but headings' and
/// captions' (an empty state's, which never paint in a cell), and no picture, frame or glyph.
pub fn nothing(ctx: &Ctx, window: &mut Window, cx: &mut App) -> bool {
    !shows(ctx, "root", 0, window, cx)
}

/// Whether a component draws words other than headings and captions, or a picture, frame or glyph.
fn shows(ctx: &Ctx, id: &str, depth: usize, window: &mut Window, cx: &mut App) -> bool {
    let Some((c, name, catalog)) = component(ctx, id) else { return false };
    if depth > 12 {
        return false;
    }
    let s = &ctx.scope;
    let said = |k: &str| !s.words(&c, k).is_empty();
    let kids = |window: &mut Window, cx: &mut App| drawn_children(ctx, &c, &name).iter().any(|ch| shows(&ctx.for_child(ch, true, false), &ch.id, depth + 1, window, cx));
    let problems = || !s.problems(&c).is_empty();
    let playable = |k: &str| crate::widgets::basic::playback::playable(&s.text(&c, k));
    match (part_of(&name, &catalog), name.as_str()) {
        ("basic", "Text") => {
            let text = s.words(&c, "text");
            if ctx.in_key {
                return !crate::widgets::basic::text::said(&text).is_empty();
            }
            s.text(&c, "variant") != "caption" && !heading_only(&text) && !text.trim().is_empty()
        }
        ("basic", "Image") => crate::widgets::media::safe_url(&s.text(&c, "url"), cx).is_some(),
        // A video, or a sound's transport's glyph.
        ("basic", "Video" | "AudioPlayer") => playable("url"),
        ("basic", "Icon") => match s.prop(&c, "name") {
            Value::String(n) => crate::widgets::basic::icons::icon(&n).is_some(),
            Value::Object(o) => o.get("svgPath").and_then(Value::as_str).is_some(),
            _ => false,
        },
        ("basic", "Tabs") => c.get("tabs").and_then(Value::as_array).into_iter().flatten().any(|t| !crate::a2ui::words_of(&s.resolve(t.get("title").unwrap_or(&Value::Null))).is_empty()) || kids(window, cx),
        ("basic", "Row" | "Column" | "List" | "Card" | "Modal") => kids(window, cx),
        ("basic", "Button") => {
            let mut k = ctx.clone();
            k.in_key = true;
            s.child(&c, "child").is_some_and(|ch| shows(&k.for_child(&ch, true, false), &ch.id, depth + 1, window, cx))
        }
        ("basic", "Divider") => false,
        ("basic", "TextField" | "DateTimeInput") => said("label") || problems(),
        // A ticked box's check is a glyph.
        ("basic", "CheckBox") => said("label") || s.flag(&c, "value") || problems(),
        ("basic", "ChoicePicker") => {
            said("label") || problems() || c.get("options").and_then(Value::as_array).into_iter().flatten().any(|o| !crate::a2ui::words_of(&s.resolve(o.get("label").unwrap_or(&Value::Null))).is_empty())
        }
        // Its value's figures.
        ("basic", "Slider") => true,
        ("house", "Line") => said("label") || s.flag(&c, "running") || s.flag(&c, "ringing") || s.number(&c, "left").is_some() || s.number(&c, "elapsed").is_some(),
        ("house", "Slot") => said("time") || said("title") || s.flag(&c, "needsYou") || s.flag(&c, "running") || s.flag(&c, "conflict"),
        ("house", "Field") => said("label") || said("value") || s.flag(&c, "alert"),
        ("house", "Title") => said("label") || s.flag(&c, "needsYou"),
        ("house", "Row") => {
            matches!(s.text(&c, "mark").as_str(), "running" | "needsYou" | "stop" | "warn")
                || !s.text(&c, "label").is_empty()
                || !s.text(&c, "detail").is_empty()
                || s.prop(&c, "values").as_array().is_some_and(|v| v.iter().any(|x| !crate::a2ui::words_of(x).is_empty()))
                || s.number(&c, "endsAt").is_some()
                || kids(window, cx)
        }
        ("house", "Pick") => ["title", "label"].iter().any(|k| !s.text(&c, k).is_empty()),
        ("house", "Check") => !s.text(&c, "label").is_empty() || !s.text(&c, "detail").is_empty() || crate::widgets::house::lines::failed(&name, &c, ctx, window, cx),
        ("house", "Entry") => crate::widgets::house::lines::failed(&name, &c, ctx, window, cx),
        ("house", "Feed") => crate::widgets::house::feed::shows(&c, ctx, window, cx),
        ("house", "Gallery") => !crate::widgets::house::gallery::pictures(&c, ctx, cx).is_empty(),
        // Its keys' glyphs.
        ("house", "Playing") | ("chart", _) | ("page", _) => true,
        ("house", "Document") => said("title"),
        _ => false,
    }
}
/// Words that are nothing once their headings' marks are gone… are a heading only when every line
/// is a heading.
fn heading_only(text: &str) -> bool {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    !lines.is_empty() && lines.iter().all(|l| l.trim_start().starts_with('#'))
}
