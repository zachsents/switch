//! The MCP catalog's own functions (`@a2ui/catalog-mcp`'s functions/), as an app's page calls them
//! with `ui/requests/function-call`: `updateDataModel`, `transformData`, `split`, `regexCapture`
//! and `callMcpTool`. A name the catalog doesn't have isn't found, as A2UI's invoker says.

use serde_json::{Map, Value};

use crate::a2ui::MCP_CATALOG;

/// What a call gave: its result (none from a function that returns nothing), and the values it
/// writes to the data model, each at its path.
pub struct Done {
    pub result: Option<Value>,
    pub writes: Vec<(String, Value)>,
}

fn gave(v: Value) -> Result<Done, String> {
    Ok(Done { result: Some(v), writes: vec![] })
}

/// Whether the catalog has a function by that name.
pub fn has(name: &str) -> bool {
    ["updateDataModel", "transformData", "split", "regexCapture", "callMcpTool"].contains(&name)
}

/// Runs one of the catalog's functions on what it was given.
pub fn call(name: &str, args: &Map<String, Value>) -> Result<Done, String> {
    let needs = |keys: &[&str]| -> Result<(), String> {
        match keys.iter().find(|k| !args.contains_key(**k)) {
            Some(k) => Err(format!("Validation failed for function '{name}': {k}: Required")),
            None => Ok(()),
        }
    };
    match name {
        "updateDataModel" => {
            needs(&["updates"])?;
            update_data_model(&args["updates"])
        }
        "transformData" => {
            needs(&["jmespath", "data"])?;
            gave(transform(&text_of(&args["jmespath"]), &args["data"])?)
        }
        "split" => {
            needs(&["value", "separator"])?;
            let sep = text_of(&args["separator"]);
            gave(each_text(&args["value"], |item| {
                let parts: Vec<Value> = if sep.is_empty() { item.chars().map(|c| Value::String(c.to_string())).collect() } else { item.split(sep.as_str()).map(|p| Value::String(p.into())).collect() };
                Value::Array(parts)
            }))
        }
        "regexCapture" => {
            needs(&["value", "pattern"])?;
            let re = safe_regex(&text_of(&args["pattern"]), "regexCapture")?;
            gave(each_text(&args["value"], |item| match re.captures(item) {
                Some(c) => Value::Array(c.iter().skip(1).map(|g| Value::String(g.map(|m| m.as_str().to_string()).unwrap_or_default())).collect()),
                None => Value::Null,
            }))
        }
        // The desktop configures no MCP client for it, so it never runs there.
        "callMcpTool" => {
            needs(&["name"])?;
            let tool = text_of(&args["name"]);
            Err(format!("Cannot execute MCP tool '{tool}': callMcpTool is not configured. Call configureMcpCatalog({{getMcpClientForTool, processor}}) first."))
        }
        _ => Err(format!("Function not found in catalog '{MCP_CATALOG}': {name}")),
    }
}

/// A value as JavaScript's `String()` writes it.
fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => crate::a2ui::expr::number_text(n.as_f64().unwrap_or(0.)),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { text_of(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `fn` on a value's text, or on each item's of a list (an item that's nothing as "").
fn each_text(v: &Value, f: impl Fn(&str) -> Value) -> Value {
    let item = |x: &Value| if x.is_null() { String::new() } else { text_of(x) };
    match v {
        Value::Array(a) => Value::Array(a.iter().map(|x| f(&item(x))).collect()),
        other => f(&item(other)),
    }
}

fn update_data_model(updates: &Value) -> Result<Done, String> {
    let Value::Object(o) = updates else {
        let kind = match updates {
            Value::Array(_) => "array",
            Value::Null => "null",
            Value::String(_) => "string",
            Value::Number(_) => "number",
            Value::Bool(_) => "boolean",
            Value::Object(_) => "object",
        };
        return Err(format!("updateDataModel expects an object of data model paths, got {kind}."));
    };
    for path in o.keys() {
        if path.is_empty() {
            return Err("updateDataModel rejected an empty key: every key must be a data model path.".into());
        }
        if let Some(seg) = path.split('/').find(|s| ["__proto__", "constructor", "prototype"].contains(s)) {
            return Err(format!("updateDataModel rejected the key '{path}': the segment '{seg}' is not allowed."));
        }
    }
    // A path not starting with "/" is the page's context's: the surface's root.
    let writes = o.iter().map(|(p, v)| (if p.starts_with('/') { p.clone() } else { format!("/{p}") }, v.clone())).collect();
    Ok(Done { result: None, writes })
}

fn transform(expression: &str, data: &Value) -> Result<Value, String> {
    let compiled = jmespath::compile(expression).map_err(|e| format!("Invalid JMESPath expression: {expression} ({e})"))?;
    let found = compiled.search(data.clone()).map_err(|e| format!("JMESPath expression {expression} failed: {e}"))?;
    serde_json::to_value(&*found).map_err(|e| format!("JMESPath expression {expression} failed: {e}"))
}

/// A pattern in the portable subset (no lookaround, no backreferences), short and safe, compiled.
fn safe_regex(source: &str, function: &str) -> Result<regex::Regex, String> {
    if !portable(source) {
        return Err(format!("{function} rejected the pattern '{source}': lookaround assertions and backreferences are not supported."));
    }
    let unsafe_ = || format!("{function} rejected the pattern '{source}': it is not a valid regular expression or it allows catastrophic backtracking.");
    if source.chars().count() > 256 || star_height(source) > 1 {
        return Err(unsafe_());
    }
    regex::Regex::new(source).map_err(|_| unsafe_())
}

fn portable(p: &str) -> bool {
    let b: Vec<char> = p.chars().collect();
    let mut in_class = false;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == '\\' {
            let next = b.get(i + 1).copied().unwrap_or(' ');
            if !in_class && (('1'..='9').contains(&next) || (next == 'k' && b.get(i + 2) == Some(&'<'))) {
                return false;
            }
            i += 1;
        } else if in_class {
            in_class = c != ']';
        } else if c == '[' {
            in_class = true;
        } else if c == '(' {
            let rest: String = b[i..].iter().take(4).collect();
            if ["(?=", "(?!", "(?<=", "(?<!"].iter().any(|o| rest.starts_with(o)) {
                return false;
            }
        }
        i += 1;
    }
    true
}

/// How deeply repeats nest in a pattern: a repeat of a group that repeats inside is two.
fn star_height(p: &str) -> usize {
    let b: Vec<char> = p.chars().collect();
    // Each open group's deepest repeat inside it so far.
    let mut stack: Vec<usize> = vec![0];
    let mut max = 0;
    let mut in_class = false;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let quantifier = |j: usize| matches!(b.get(j), Some('*') | Some('+') | Some('{'));
        if c == '\\' {
            i += 2;
            if !in_class && quantifier(i) {
                let top = stack.last_mut().expect("root");
                *top = (*top).max(1);
                max = max.max(*top);
            }
            continue;
        }
        if in_class {
            in_class = c != ']';
            if !in_class && quantifier(i + 1) {
                let top = stack.last_mut().expect("root");
                *top = (*top).max(1);
                max = max.max(*top);
            }
        } else if c == '[' {
            in_class = true;
        } else if c == '(' {
            stack.push(0);
        } else if c == ')' {
            let last_group = stack.pop().unwrap_or(0);
            if stack.is_empty() {
                stack.push(0);
            }
            let h = if quantifier(i + 1) { last_group + 1 } else { last_group };
            let top = stack.last_mut().expect("root");
            *top = (*top).max(h);
            max = max.max(h);
        } else if !matches!(c, '*' | '+' | '?' | '{' | '}' | '|' | '^' | '$') && quantifier(i + 1) {
            let top = stack.last_mut().expect("root");
            *top = (*top).max(1);
            max = max.max(*top);
        }
        i += 1;
    }
    max
}
