//! A2UI v1.0 as the desktop's host runs it (`@a2ui/web_core`'s MessageProcessor, as
//! `widgets/host.ts` drives it): each surface's components by id and its data model, from
//! `createSurface`, `updateComponents`, `updateDataModel` and `deleteSurface`; values bound to the
//! data model (`{"@path"}`, relative inside a template's item), function calls (`{"@call"}`, the basic
//! catalog's functions, `expr.rs`), child lists (ids, or a template over a list in the data model),
//! and checks. What draws a surface is `widgets/render.rs`.

pub mod expr;

use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{Map, Value};

pub const BASIC_CATALOG: &str = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
pub const SWITCH_CATALOG: &str = "https://switch.ax/catalogs/v1/catalog.json";
pub const MCP_CATALOG: &str = "https://a2ui.org/specification/v1_0/catalogs/mcp/catalog.json";

/// One surface: its components by id, its data model, the catalog its parts are from unless one
/// says otherwise.
#[derive(Clone, Debug, Default)]
pub struct Surface {
    pub catalog: String,
    pub components: HashMap<String, Rc<Value>>,
    pub data: Value,
    /// Moves on every change.
    pub version: u64,
}

/// A child to draw: a component, and where in the data model it's drawn (a template's item).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Child {
    pub id: String,
    pub base: String,
}

impl Surface {
    pub fn new() -> Self {
        Surface { catalog: BASIC_CATALOG.into(), data: Value::Object(Map::new()), ..Default::default() }
    }

    /// Takes one message (its surface id already this surface's).
    pub fn take(&mut self, m: &Value) {
        // A v1.0 createSurface may carry the surface's data model and its components: the data first,
        // then the components, as A2UI's processor takes them.
        if let Some(c) = m.get("createSurface") {
            if let Some(cat) = c.get("catalogId").and_then(Value::as_str) {
                self.catalog = cat.into();
            }
            if let Some(d @ Value::Object(_)) = c.get("dataModel") {
                self.data = d.clone();
            }
            for c in c.get("components").and_then(Value::as_array).into_iter().flatten() {
                if let Some(id) = c.get("id").and_then(Value::as_str) {
                    self.components.insert(id.into(), Rc::new(c.clone()));
                }
            }
        }
        if let Some(u) = m.get("updateComponents") {
            for c in u.get("components").and_then(Value::as_array).into_iter().flatten() {
                if let Some(id) = c.get("id").and_then(Value::as_str) {
                    self.components.insert(id.into(), Rc::new(c.clone()));
                }
            }
        }
        if let Some(u) = m.get("updateDataModel") {
            let path = u.get("path").and_then(Value::as_str).unwrap_or("/");
            match u.get("value") {
                Some(v) => set(&mut self.data, path, v.clone()),
                None => remove(&mut self.data, path),
            }
        }
        self.version += 1;
    }

    pub fn component(&self, id: &str) -> Option<&Rc<Value>> {
        self.components.get(id)
    }

    /// The catalog a component is drawn from: its own, else the surface's.
    pub fn catalog_of<'a>(&'a self, c: &'a Value) -> &'a str {
        c.get("catalogId").and_then(Value::as_str).unwrap_or(&self.catalog)
    }

    /// What the data model holds at an absolute path.
    pub fn get(&self, path: &str) -> Value {
        pointer(&self.data, path).cloned().unwrap_or(Value::Null)
    }

    /// Writes a value at an absolute path (a control's two-way binding).
    pub fn write(&mut self, path: &str, value: Value) {
        set(&mut self.data, path, value);
        self.version += 1;
    }
}

/// The JSON Pointer's tokens.
fn tokens(path: &str) -> Vec<String> {
    path.split('/').filter(|t| !t.is_empty()).map(|t| t.replace("~1", "/").replace("~0", "~")).collect()
}

pub fn pointer<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    let mut at = v;
    for t in tokens(path) {
        at = match at {
            Value::Object(o) => o.get(&t)?,
            Value::Array(a) => a.get(t.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(at)
}

/// Sets a value at a path, making the objects (or lists, for an index) on the way.
pub fn set(root: &mut Value, path: &str, value: Value) {
    let ts = tokens(path);
    if ts.is_empty() {
        *root = value;
        return;
    }
    let mut at = root;
    for (i, t) in ts.iter().enumerate() {
        let last = i + 1 == ts.len();
        if !at.is_object() && !at.is_array() {
            *at = Value::Object(Map::new());
        }
        let next_is_index = ts.get(i + 1).is_some_and(|n| n.parse::<usize>().is_ok());
        match at {
            Value::Array(a) => {
                let Ok(ix) = t.parse::<usize>() else { return };
                while a.len() <= ix {
                    a.push(Value::Null);
                }
                if last {
                    a[ix] = value;
                    return;
                }
                if a[ix].is_null() {
                    a[ix] = if next_is_index { Value::Array(vec![]) } else { Value::Object(Map::new()) };
                }
                at = &mut a[ix];
            }
            Value::Object(o) => {
                if last {
                    o.insert(t.clone(), value);
                    return;
                }
                let e = o.entry(t.clone()).or_insert_with(|| if next_is_index { Value::Array(vec![]) } else { Value::Object(Map::new()) });
                at = e;
            }
            _ => return,
        }
    }
}

fn remove(root: &mut Value, path: &str) {
    let ts = tokens(path);
    let Some((last, head)) = ts.split_last() else {
        *root = Value::Object(Map::new());
        return;
    };
    let parent = format!("/{}", head.join("/"));
    let Some(p) = root.pointer_mut(if head.is_empty() { "" } else { &parent }) else { return };
    match p {
        Value::Object(o) => {
            o.remove(last);
        }
        Value::Array(a) => {
            if let Ok(ix) = last.parse::<usize>()
                && ix < a.len()
            {
                a.remove(ix);
            }
        }
        _ => {}
    }
}

/// A path as an absolute one: a relative path is under `base` (a template's item).
pub fn absolute(base: &str, path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else if path.is_empty() || path == "." {
        // The place itself (A2UI's resolvePath).
        let base = base.trim_end_matches('/');
        if base.is_empty() { "/".into() } else { base.to_string() }
    } else {
        format!("{}/{}", base.trim_end_matches('/'), path)
    }
}

/// A binding's path, if the value is one: v1.0's `{"@path"}` (a `{"path"}` is an object as it is),
/// not a child list's template.
pub fn path_of(v: &Value) -> Option<&str> {
    let o = v.as_object()?;
    if o.contains_key("componentId") {
        return None;
    }
    o.get("@path").and_then(Value::as_str)
}

/// A function call's name, if the value is one: v1.0's `{"@call"}`.
pub fn call_of(v: &Value) -> Option<&str> {
    let o = v.as_object()?;
    if path_of(v).is_some() {
        return None;
    }
    o.get("@call").and_then(Value::as_str)
}

/// Where a component is read: its surface and the data path it's drawn at.
#[derive(Clone)]
pub struct Scope {
    pub surface: Rc<Surface>,
    pub base: String,
}

impl Scope {
    pub fn new(surface: Rc<Surface>) -> Self {
        Scope { surface, base: String::new() }
    }

    pub fn at(&self, base: &str) -> Self {
        Scope { surface: self.surface.clone(), base: base.into() }
    }

    pub fn abs(&self, path: &str) -> String {
        absolute(&self.base, path)
    }

    /// A dynamic value resolved: a literal as it is, a binding to what the data model holds, a
    /// call to what it answers. A literal object or list has its parts resolved too.
    pub fn resolve(&self, v: &Value) -> Value {
        if let Some(p) = path_of(v) {
            return self.surface.get(&self.abs(p));
        }
        if let Some(name) = call_of(v) {
            return expr::call(name, v.get("args").unwrap_or(&Value::Null), self);
        }
        match v {
            Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), self.resolve(x))).collect()),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.resolve(x)).collect()),
            _ => v.clone(),
        }
    }

    /// A property of a component, resolved.
    pub fn prop(&self, c: &Value, key: &str) -> Value {
        c.get(key).map(|v| self.resolve(v)).unwrap_or(Value::Null)
    }

    /// A property as words: a string as it is, a figure or flag as written, else empty (the
    /// desktop's `wordsOf`).
    pub fn words(&self, c: &Value, key: &str) -> String {
        words_of(&self.prop(c, key))
    }

    /// A property as a string, else empty.
    pub fn text(&self, c: &Value, key: &str) -> String {
        self.prop(c, key).as_str().unwrap_or_default().to_string()
    }

    pub fn number(&self, c: &Value, key: &str) -> Option<f64> {
        self.prop(c, key).as_f64()
    }

    pub fn flag(&self, c: &Value, key: &str) -> bool {
        self.prop(c, key).as_bool() == Some(true)
    }

    /// The absolute path a property is bound to, for writing back.
    pub fn bound(&self, c: &Value, key: &str) -> Option<String> {
        c.get(key).and_then(path_of).map(|p| self.abs(p))
    }

    /// A child list: its ids, or a template's component once per item of the list it's over.
    pub fn children(&self, c: &Value, key: &str) -> Vec<Child> {
        match c.get(key) {
            Some(Value::Array(ids)) => ids.iter().filter_map(|i| i.as_str()).map(|id| Child { id: id.into(), base: self.base.clone() }).collect(),
            Some(Value::Object(t)) => {
                let Some(id) = t.get("componentId").and_then(Value::as_str) else { return vec![] };
                let path = self.abs(t.get("path").and_then(Value::as_str).unwrap_or(""));
                match self.surface.get(&path) {
                    Value::Array(items) => {
                        (0..items.len()).map(|i| Child { id: id.into(), base: format!("{}/{i}", path.trim_end_matches('/')) }).collect()
                    }
                    Value::Object(items) => {
                        items.keys().map(|k| Child { id: id.into(), base: format!("{}/{k}", path.trim_end_matches('/')) }).collect()
                    }
                    _ => vec![],
                }
            }
            _ => vec![],
        }
    }

    /// A single child id, as a child here.
    pub fn child(&self, c: &Value, key: &str) -> Option<Child> {
        c.get(key).and_then(Value::as_str).map(|id| Child { id: id.into(), base: self.base.clone() })
    }

    /// What a component's checks find wrong, as A2UI's binder reads them: each failing check of
    /// error severity (a warning or a note blocks nothing), its message the check's own, else the
    /// one its function answers, else "Validation failed". A check bound to a path reads a result
    /// written there, whose message carries the finding: there the check's own message is only the
    /// fallback.
    pub fn problems(&self, c: &Value) -> Vec<String> {
        let mut out = vec![];
        for rule in c.get("checks").and_then(Value::as_array).into_iter().flatten() {
            let condition = rule.get("condition").unwrap_or(rule);
            let own = rule.get("message").and_then(Value::as_str).map(str::to_string);
            let path_bound = condition.get("@path").is_some_and(Value::is_string) && condition.get("@call").is_none();
            let explicit = if path_bound { None } else { own.clone() };
            let fallback = own.unwrap_or_else(|| "Validation failed".into());
            let got = self.resolve(condition);
            let (valid, message, error) = match &got {
                Value::Object(o) if o.contains_key("valid") => {
                    let said = match o.get("message") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(m)) => Some(m.clone()),
                        Some(v @ (Value::Number(_) | Value::Bool(_))) => Some(words_of(v)),
                        Some(v) => Some(v.to_string()),
                    };
                    let severity = o.get("severity").and_then(Value::as_str);
                    (expr::truthy(o.get("valid").unwrap_or(&Value::Null)), explicit.or(said).unwrap_or(fallback), !matches!(severity, Some("warning" | "info")))
                }
                v => (expr::truthy(v), explicit.unwrap_or(fallback), true),
            };
            if !valid && error {
                out.push(message);
            }
        }
        out
    }
}

/// A value's words, as A2UI's own parts show them: a figure or a flag as written, nothing as nothing.
pub fn words_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => expr::number_text(n.as_f64().unwrap_or(0.)),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// What's said when a part is pressed: an event to the extension (its name and its context
/// resolved), or a function run here.
pub enum Pressed {
    Event { name: String, context: Value },
    Function { name: String, args: Value },
    None,
}

pub fn pressed(scope: &Scope, action: &Value) -> Pressed {
    let Some(o) = action.as_object() else { return Pressed::None };
    // A function call: `{functionCall}`, or the call itself (`{call}` or `{@call}`), run here.
    let call = o.get("functionCall").filter(|f| f.is_object()).or_else(|| (o.contains_key("call") || o.contains_key("@call")).then_some(action));
    if let Some(f) = call {
        // A pressed call may name itself either way (A2UI's executeActionFunctionCall).
        let name = f.get("@call").or_else(|| f.get("call")).and_then(Value::as_str).unwrap_or_default().to_string();
        let args = f.get("args").map(|a| scope.resolve(a)).unwrap_or(Value::Null);
        return Pressed::Function { name, args };
    }
    // An event: `{event: {name, context}}`, or `{name, context}` as it is; one with no name says nothing.
    let event = match o.get("event") {
        Some(e @ Value::Object(_)) => e,
        _ if o.contains_key("name") => action,
        _ => return Pressed::None,
    };
    let name = event.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    if name.is_empty() {
        return Pressed::None;
    }
    let context = match event.get("context") {
        Some(Value::Object(c)) => Value::Object(c.iter().map(|(k, v)| (k.clone(), scope.resolve(v))).collect()),
        _ => Value::Object(Map::new()),
    };
    Pressed::Event { name, context }
}

/// Parts Switch's catalog had before A2UI's basic catalog drew them in its look, read as what
/// replaced them (old-parts.ts): Picture{src} as Image{url}, Stack as Column, Lines as List,
/// Head{label} as a Markdown heading, Empty{label} as a caption.
pub fn current(c: &Value) -> Value {
    let id = c.get("id").cloned().unwrap_or(Value::Null);
    let base = |name: &str| {
        let mut m = Map::new();
        m.insert("id".into(), id.clone());
        m.insert("catalogId".into(), Value::String(BASIC_CATALOG.into()));
        m.insert("component".into(), Value::String(name.into()));
        m
    };
    let field = |k: &str| c.get(k).cloned().unwrap_or(Value::Null);
    match c.get("component").and_then(Value::as_str) {
        Some("Picture") => {
            let mut m = base("Image");
            m.insert("url".into(), field("src"));
            Value::Object(m)
        }
        Some("Stack") => {
            let mut m = base("Column");
            m.insert("children".into(), field("children"));
            Value::Object(m)
        }
        Some("Lines") => {
            let mut m = base("List");
            m.insert("children".into(), field("children"));
            Value::Object(m)
        }
        Some("Head") => {
            let mut m = base("Text");
            let label = field("label");
            let text = if let Some(p) = path_of(&label) {
                serde_json::json!({ "@call": "formatString", "catalogId": BASIC_CATALOG, "args": { "value": format!("# ${{{p}}}") } })
            } else if let Some(s) = label.as_str() {
                Value::String(format!("# {s}"))
            } else {
                label
            };
            m.insert("text".into(), text);
            Value::Object(m)
        }
        Some("Empty") => {
            let mut m = base("Text");
            m.insert("text".into(), field("label"));
            m.insert("variant".into(), Value::String("caption".into()));
            Value::Object(m)
        }
        _ => c.clone(),
    }
}

/// A widget's messages under its own surface id, so two extensions' surfaces never collide, each
/// part Switch's catalog no longer has read as what replaced it (host.ts `scoped`).
pub fn scoped(key: &str, messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
            let mut out = m.as_object().cloned().unwrap_or_default();
            for kind in ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"] {
                if let Some(Value::Object(body)) = out.get(kind).cloned() {
                    let mut body = body;
                    body.insert("surfaceId".into(), Value::String(key.into()));
                    if let Some(Value::Array(cs)) = body.get("components").cloned() {
                        body.insert("components".into(), Value::Array(cs.iter().map(current).collect()));
                    }
                    out.insert(kind.into(), Value::Object(body));
                }
            }
            Value::Object(out)
        })
        .collect()
}
