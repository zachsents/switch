//! Widgets: interactive views of an app, written once in A2UI 1.0 with its basic catalog, so any
//! A2UI renderer draws them. Each widget has a tool, `show_<name>`, whose result is a line of
//! text for text-only agents and an embedded `application/a2ui+json` resource holding the
//! widget's A2UI messages. The same messages are a resource of their own,
//! `<app>://widget/<name>?<arguments>`, which hosts subscribe to so the widget stays live.
//!
//! A tap on a widget is an A2UI `action` whose name is one of the app's tools and whose context
//! is that tool's arguments, so drawing hosts call `tools/call` with them and the change happens
//! exactly as if an agent had made it.
//!
//! Hosts that draw MCP Apps rather than A2UI get the kit's renderer, `ui://<app>/widget`, when the
//! binary holds one (`assets/widget.html`, one HTML file that draws any widget; this workspace
//! leaves it out). It keeps the widget live through `watch_widget`, a tool only views can call.

use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

use gpui::{App, Global};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use url::Url;

use super::{Reply, tool_name, tool_title};
use crate::{AppInfo, Assets, Icon};

/// The A2UI basic catalog, the only components and functions widgets use.
pub(crate) const BASIC_CATALOG: &str =
    "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";

pub(crate) const A2UI_MIME_TYPE: &str = "application/a2ui+json";

pub(crate) const MCP_APP_MIME_TYPE: &str = "text/html;profile=mcp-app";

/// Where a widget resource's content version goes in its `_meta`.
pub(crate) const VERSION_KEY: &str = "plain/version";

/// The tool views call to keep a widget live.
pub(crate) const WATCH_TOOL: &str = "watch_widget";

/// A widget as it stands right now.
pub struct Surface {
    /// What the widget shows, in a line, for agents that read rather than draw it.
    pub summary: String,
    /// The arguments that show this same view again, with defaults filled in (like which list
    /// was selected), so the widget keeps showing it as the app changes.
    pub arguments: Value,
    /// A2UI components from the basic catalog, one of them with the id `root`.
    pub components: Vec<Value>,
    /// The data model the components bind to.
    pub data: Value,
}

struct Widget {
    /// The widget's name, like `list`. Its tool is `show_<name>`.
    name: String,
    description: String,
    schema: Value,
    draw: Box<Draw>,
}

/// Draws a widget from its arguments as JSON.
type Draw = dyn Fn(&Value, &App) -> Result<Surface, String>;

#[derive(Default)]
struct Widgets(Vec<Widget>);

impl Global for Widgets {}

/// Adds a widget to what the app offers agents. Its arguments are a struct named `Show<Name>`,
/// whose doc comment describes the widget for agents and whose fields are the tool's input, the
/// way actions become tools. `draw` makes the widget from them, or fails with a message for the
/// agent, like an unknown id.
pub fn widget<A: DeserializeOwned + JsonSchema + 'static>(
    cx: &mut App,
    draw: impl Fn(&A, &App) -> Result<Surface, String> + 'static,
) {
    let tool = tool_name(&A::schema_name());
    let name = tool
        .strip_prefix("show_")
        .expect("widget arguments are named Show<Name>")
        .to_string();
    let mut schema = Value::from(schemars::SchemaGenerator::default().into_root_schema_for::<A>());
    let fields = schema.as_object_mut().expect("arguments are a struct");
    let description = fields
        .remove("description")
        .and_then(|description| description.as_str().map(str::to_string))
        .unwrap_or_default();
    fields.remove("title");
    fields.remove("$schema");
    cx.default_global::<Widgets>().0.push(Widget {
        name,
        description,
        schema,
        draw: Box::new(move |arguments, cx| {
            let arguments = serde_json::from_value(arguments.clone())
                .map_err(|error| format!("invalid arguments: {error}"))?;
            draw(&arguments, cx)
        }),
    });
}

fn widgets(cx: &App) -> &[Widget] {
    cx.try_global::<Widgets>()
        .map_or(&[], |Widgets(widgets)| widgets.as_slice())
}

/// The widgets' tools, and the one views call to stay live.
pub(super) fn tools(app: AppInfo, cx: &App) -> Vec<Value> {
    let widgets = widgets(cx);
    let renderer = has_renderer().then(|| renderer_uri(app));
    let shows = widgets.iter().map(move |widget| {
        let tool = format!("show_{}", widget.name);
        let mut entry = json!({
            "name": tool,
            "title": tool_title(&tool),
            "description": widget.description,
            "inputSchema": widget.schema,
            "annotations": { "readOnlyHint": true },
        });
        if let Some(renderer) = &renderer {
            entry["_meta"] = json!({
                "ui": { "resourceUri": renderer, "visibility": ["model", "app"] },
                // Hosts written before `ui.resourceUri` read this.
                "ui/resourceUri": renderer,
            });
        }
        entry
    });
    let watch = json!({
        "name": WATCH_TOOL,
        "title": "Watch Widget",
        "description": "For widget views: waits until the widget resource at `uri` reads \
                        differently from `version`, for up to about 25 seconds, then returns its \
                        A2UI messages and new version. Without a version it returns at once.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "uri": { "type": "string", "description": "The widget resource's URI." },
                "version": {
                    "type": ["string", "null"],
                    "description": "The version the view shows, from the last result's `_meta`.",
                },
            },
            "required": ["uri"],
        },
        "annotations": { "readOnlyHint": true },
        "_meta": { "ui": { "visibility": ["app"] } },
    });
    let watch = (!widgets.is_empty()).then_some(watch);
    shows.chain(watch).collect()
}

/// The resource templates widgets are read through.
pub(super) fn templates(app: AppInfo, cx: &App) -> Vec<Value> {
    widgets(cx)
        .iter()
        .map(|widget| {
            let fields: Vec<_> = widget.schema["properties"]
                .as_object()
                .into_iter()
                .flat_map(|properties| properties.keys().cloned())
                .collect();
            let query = if fields.is_empty() {
                String::new()
            } else {
                format!("{{?{}}}", fields.join(","))
            };
            json!({
                "uriTemplate": format!("{}://widget/{}{query}", app.id, widget.name),
                "name": widget.name,
                "title": tool_title(&widget.name),
                "description": widget.description,
                "mimeType": A2UI_MIME_TYPE,
            })
        })
        .collect()
}

pub(super) fn is_widget_tool(tool: &str, cx: &App) -> bool {
    find(tool.strip_prefix("show_").unwrap_or_default(), cx).is_some()
}

fn find<'a>(name: &str, cx: &'a App) -> Option<&'a Widget> {
    widgets(cx).iter().find(|widget| widget.name == name)
}

/// Answers a `show_<name>` call: the widget's summary and its A2UI messages.
pub(super) fn show(app: AppInfo, tool: &str, arguments: &Value, cx: &App) -> Reply {
    let name = tool.strip_prefix("show_").unwrap_or_default();
    let widget = find(name, cx).ok_or_else(|| format!("unknown tool `{tool}`"))?;
    let surface = (widget.draw)(arguments, cx)?;
    let uri = widget_uri(app, name, &surface.arguments);
    let text = messages(app, name, &surface).to_string();
    Ok(json!({
        "content": [
            { "type": "text", "text": surface.summary },
            embedded(&uri, text),
        ],
        "isError": false,
    }))
}

/// A widget's messages as a tool result's embedded resource, for the person rather than the
/// model.
pub(crate) fn embedded(uri: &str, text: String) -> Value {
    json!({
        "type": "resource",
        "resource": {
            "uri": uri,
            "mimeType": A2UI_MIME_TYPE,
            "_meta": { VERSION_KEY: version(&text) },
            "text": text,
        },
        "annotations": { "audience": ["user"] },
    })
}

/// Reads a widget resource, if `uri` names one of the app's widgets.
pub(super) fn read(app: AppInfo, uri: &str, cx: &App) -> Option<Reply> {
    let (name, arguments) = parse_widget_uri(app, uri)?;
    let widget = find(&name, cx)?;
    let read = (widget.draw)(&arguments, cx).or_else(|error| {
        // Query values are strings; a widget whose arguments aren't gets them as JSON.
        let typed = arguments_from_json(&arguments);
        (widget.draw)(&typed, cx).map_err(|_| error)
    });
    Some(read.map(|surface| {
        let text = messages(app, &name, &surface).to_string();
        json!({
            "contents": [{
                "uri": uri,
                "mimeType": A2UI_MIME_TYPE,
                "_meta": { VERSION_KEY: version(&text) },
                "text": text,
            }],
        })
    }))
}

fn messages(app: AppInfo, name: &str, surface: &Surface) -> Value {
    surface.messages(&surface_id(app, name, &surface.arguments))
}

impl Surface {
    /// The A2UI messages that draw the widget from nothing as the surface `id`, as agents get
    /// them. Drawn again over a surface that already exists, hosts skip `createSurface`; the
    /// components and data then replace what was there. Also how an app's tests draw its
    /// widgets with an A2UI renderer.
    pub fn messages(&self, id: &str) -> Value {
        json!([
            { "version": "1.0", "createSurface": { "surfaceId": id, "catalogId": BASIC_CATALOG } },
            { "version": "1.0", "updateComponents": { "surfaceId": id, "components": self.components } },
            { "version": "1.0", "updateDataModel": { "surfaceId": id, "path": "/", "value": self.data } },
        ])
    }
}

/// Identifies what a resource reads as, so a view can tell when it changed.
pub(crate) fn version(text: &str) -> String {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// A surface id that's the same each time the widget is shown with the same arguments, and a
/// valid A2UI identifier.
fn surface_id(app: AppInfo, name: &str, arguments: &Value) -> String {
    let mut hasher = DefaultHasher::new();
    canonical(arguments).hash(&mut hasher);
    format!("{}_{}_{:08x}", app.id, name, hasher.finish() as u32)
}

/// `images://widget/list?list=k3f9x2`: each argument is a query value, as text unless it's JSON
/// that isn't a string.
fn widget_uri(app: AppInfo, name: &str, arguments: &Value) -> String {
    let mut uri = format!("{}://widget/{name}", app.id);
    let fields = arguments.as_object().into_iter().flatten();
    let mut pairs: Vec<_> = fields
        .filter(|(_, value)| !value.is_null())
        .map(|(field, value)| {
            let text = value
                .as_str()
                .map_or_else(|| canonical(value), str::to_string);
            (field.clone(), text)
        })
        .collect();
    pairs.sort();
    if !pairs.is_empty() {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        uri.push('?');
        uri.push_str(&query);
    }
    uri
}

/// JSON with every object's keys in order, so equal values always read the same.
fn canonical(value: &Value) -> String {
    match value {
        Value::Object(fields) => {
            let mut fields: Vec<_> = fields.iter().collect();
            fields.sort_by_key(|(field, _)| *field);
            let fields: Vec<_> = fields
                .into_iter()
                .map(|(field, value)| {
                    format!("{}:{}", Value::from(field.as_str()), canonical(value))
                })
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        Value::Array(items) => {
            let items: Vec<_> = items.iter().map(canonical).collect();
            format!("[{}]", items.join(","))
        }
        value => value.to_string(),
    }
}

/// The widget a resource URI names, and its arguments as text.
fn parse_widget_uri(app: AppInfo, uri: &str) -> Option<(String, Value)> {
    let parsed = Url::parse(uri).ok()?;
    if parsed.scheme() != app.id || parsed.host_str() != Some("widget") {
        return None;
    }
    let name = parsed.path().trim_start_matches('/').to_string();
    let arguments: Map<String, Value> = parsed
        .query_pairs()
        .map(|(field, value)| (field.into_owned(), Value::String(value.into_owned())))
        .collect();
    Some((name, Value::Object(arguments)))
}

/// Arguments read from a query, with each value that's JSON other than a string taken as JSON.
fn arguments_from_json(arguments: &Value) -> Value {
    let fields = arguments.as_object().into_iter().flatten();
    let typed: Map<String, Value> = fields
        .map(|(field, value)| {
            let text = value.as_str().unwrap_or_default();
            let typed = serde_json::from_str(text).unwrap_or_else(|_| value.clone());
            (field.clone(), typed)
        })
        .collect();
    Value::Object(typed)
}

pub(super) fn renderer_uri(app: AppInfo) -> String {
    format!("ui://{}/widget", app.id)
}

/// Whether the binary holds the renderer, `assets/widget.html`, a page drawing A2UI for MCP Apps.
/// Without it, hosts draw widgets from their A2UI alone.
fn has_renderer() -> bool {
    Assets::get("widget.html").is_some()
}

/// The renderer's entry in `resources/list`, if the binary holds it.
pub(super) fn renderer_resource(app: AppInfo) -> Option<Value> {
    has_renderer().then(|| json!({
        "uri": renderer_uri(app),
        "name": "widget",
        "title": format!("{} widgets", app.name),
        "description": format!("Draws {}'s widgets in hosts that show MCP Apps.", app.name),
        "mimeType": MCP_APP_MIME_TYPE,
        "_meta": { "ui": { "prefersBorder": true } },
    }))
}

/// The renderer itself, for `resources/read`. It's part of the app's binary, so it reads
/// without the app running.
pub(crate) fn renderer(app: AppInfo) -> Option<Value> {
    let html = Assets::get("widget.html")?;
    Some(json!({
        "contents": [{
            "uri": renderer_uri(app),
            "mimeType": MCP_APP_MIME_TYPE,
            "text": String::from_utf8_lossy(&html.data),
            "_meta": { "ui": { "prefersBorder": true } },
        }],
    }))
}

/// A kit icon for an A2UI `Icon`'s `name`: its outline as a path in the 24-unit box A2UI
/// renderers draw custom icons in, so widgets show the suite's icons everywhere.
pub fn svg_icon(icon: Icon) -> Value {
    let data = Assets::get(icon.path()).expect("icon is embedded").data;
    let svg = String::from_utf8_lossy(&data);
    let paths: Vec<_> = svg
        .split(" d=\"")
        .skip(1)
        .filter_map(|rest| rest.split('"').next())
        .map(|path| scale_path(path, 24. / 256.))
        .collect();
    json!({ "svgPath": paths.join(" ") })
}

/// Scales SVG path data by `factor`, as if drawn in a box that much bigger. Arc rotations and
/// flags stay as they are.
fn scale_path(path: &str, factor: f64) -> String {
    let mut output = String::new();
    let mut characters = path.chars().peekable();
    let mut command = ' ';
    let mut argument = 0;
    while let Some(&character) = characters.peek() {
        if character.is_ascii_alphabetic() {
            characters.next();
            command = character;
            argument = 0;
            output.push(character);
            continue;
        }
        if character.is_whitespace() || character == ',' {
            characters.next();
            continue;
        }
        let arc = command.eq_ignore_ascii_case(&'a');
        // An arc's flags are single digits that may run straight into what follows.
        if arc && matches!(argument % 7, 3 | 4) {
            characters.next();
            push_number(&mut output, &character.to_string());
            argument += 1;
            continue;
        }
        let number = read_number(&mut characters);
        if number.is_empty() {
            characters.next();
            continue;
        }
        let keep = arc && argument % 7 == 2;
        let value: f64 = number.parse().unwrap_or_default();
        let scaled = if keep { value } else { value * factor };
        push_number(&mut output, &format_number(scaled));
        argument += 1;
    }
    output
}

/// Reads one number of path data: an optional sign, digits with at most one point, and an
/// exponent. A second point or a sign starts the next number.
fn read_number(characters: &mut std::iter::Peekable<std::str::Chars>) -> String {
    let mut number = String::new();
    let mut seen_point = false;
    let mut seen_exponent = false;
    while let Some(&character) = characters.peek() {
        let starts = number.is_empty();
        let accepted = match character {
            '+' | '-' => starts || number.ends_with(['e', 'E']),
            '.' => !seen_point && !seen_exponent,
            'e' | 'E' => !seen_exponent && !starts,
            digit => digit.is_ascii_digit(),
        };
        if !accepted {
            break;
        }
        seen_point |= character == '.';
        seen_exponent |= matches!(character, 'e' | 'E');
        number.push(character);
        characters.next();
    }
    number
}

fn push_number(output: &mut String, number: &str) {
    let after_command = output
        .chars()
        .last()
        .is_none_or(|last| last.is_ascii_alphabetic());
    if !after_command && !number.starts_with('-') {
        output.push(' ');
    }
    output.push_str(number);
}

/// A number with at most three decimals, without trailing zeros.
fn format_number(value: f64) -> String {
    let text = format!("{value:.3}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    match text {
        "-0" | "" => "0".to_string(),
        text => text.to_string(),
    }
}
