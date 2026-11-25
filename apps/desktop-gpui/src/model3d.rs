//! A 3D file in a chat, to turn (the desktop's `ui/model.tsx`): STL, 3MF, GLB, glTF or OBJ, drawn
//! with wgpu off screen and handed to gpui as pictures. Dragging turns it, a pinch zooms, and
//! scrolling scrolls the chat past it; a click opens it full screen (`viewer.rs`), where the wheel
//! zooms it too. It's fetched as the core's light copy, so a 100 MB scan
//! arrives as a few MB. One model at a time is live, the one the pointer is over; the rest are
//! pictures of it (a 3MF's own thumbnail when it has one). All of them are drawn with the app's one
//! GPU device. Printing files are Z-up.

use std::collections::HashMap;
use std::f32::consts::{PI, TAU};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use bytemuck::{Pod, Zeroable};
use glam::{Mat3, Mat4, Vec3};
use gpui::{
    AnyElement, App, AppContext, AsyncApp, Bounds, ClickEvent, Context, Corners, DispatchPhase, ElementId, Entity, Global, Image,
    ImageFormat, ImageSource, InteractiveElement, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ObjectFit, ParentElement, PinchEvent, Pixels, Point, Render, RenderImage, ScrollEvent,
    StatefulInteractiveElement, Styled, StyledImage, WeakEntity, Window, canvas, div, img, prelude::*, px, svg,
};
use wgpu::util::DeviceExt;

use crate::look::{Look, u};
use crate::marks;
use crate::nav::Beat;
use crate::net::Net;

/// Where a model shows: in a chat, or in an ask.
pub enum ModelSize {
    Chat,
    Ask,
}

/// The picture of a model at rest, in pixels.
const PICTURE: (u32, u32) = (840, 640);
const FOV: f32 = 35.;
/// How long a model no one has drawn stays loaded.
const KEEP: Duration = Duration::from_secs(10 * 60);
/// OrbitControls' damping, and the change under which it stops drawing.
const DAMPING: f32 = 0.05;
const EPS: f32 = 1e-6;
const CANT: &str = "Can't load";
/// MeshStandardMaterial's grey, roughness and metalness, as the TypeScript draws STL and OBJ.
const GREY: u32 = 0xa8adb4;
const ROUGHNESS: f32 = 0.55;
const METALNESS: f32 = 0.05;
const SAMPLES: u32 = 4;
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;
const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

/// A 3D file to turn, by its blob route (e.g. "/blobs/<hash>") and its name.
pub fn model_view(route: &str, name: &str, size: ModelSize, _window: &mut Window, cx: &mut App) -> AnyElement {
    let view = Models::view(route, name, cx);
    let (w, h) = match size {
        ModelSize::Chat => (u(320.), u(240.)),
        ModelSize::Ask => (u(128.), u(96.)),
    };
    // `max-w-full` in a chat: narrower than it, it shrinks rather than being cut.
    div().flex_none().w(w).h(h).when(matches!(size, ModelSize::Chat), |d| d.max_w_full()).child(view).into_any_element()
}

// The model, read.

/// A corner of a triangle as the GPU takes it: its place, its normal, its colour (linear, times the
/// part's) and where it is on the part's picture.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    position: [f32; 3],
    normal: [f32; 3],
    color: [f32; 4],
    uv: [f32; 2],
}

/// Triangles that share a material.
struct Part {
    vertices: Vec<Vertex>,
    color: [f32; 4],
    roughness: f32,
    metalness: f32,
    picture: Option<image::RgbaImage>,
    double_sided: bool,
}

struct Mesh {
    parts: Vec<Part>,
}

impl Mesh {
    fn triangles(&self) -> usize {
        self.parts.iter().map(|p| p.vertices.len() / 3).sum()
    }
}

/// An sRGB colour, linear.
fn linear(hex: u32) -> [f32; 4] {
    let c = |v: u32| {
        let s = (v & 0xff) as f32 / 255.;
        if s <= 0.04045 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
    };
    [c(hex >> 16), c(hex >> 8), c(hex), 1.]
}

const WHITE: [f32; 4] = [1., 1., 1., 1.];

fn extension(name: &str) -> String {
    name.rsplit('.').next().unwrap_or_default().to_lowercase()
}

/// A triangle's corners with its own normal, in the order that faces out.
fn flat(out: &mut Vec<Vertex>, p: [Vec3; 3], colors: [[f32; 4]; 3]) {
    let n = (p[1] - p[0]).cross(p[2] - p[0]).normalize_or_zero();
    for i in 0..3 {
        out.push(Vertex { position: p[i].into(), normal: n.into(), color: colors[i], uv: [0., 0.] });
    }
}

fn grey(vertices: Vec<Vertex>) -> Part {
    Part { vertices, color: linear(GREY), roughness: ROUGHNESS, metalness: METALNESS, picture: None, double_sided: false }
}

/// The model's triangles, upright.
fn parse(data: &[u8], name: &str) -> Option<Mesh> {
    let ext = extension(name);
    if ext == "glb" || ext == "gltf" {
        return gltf_mesh(data);
    }
    if ext == "obj" {
        return obj_mesh(data);
    }
    let mut mesh = if ext == "3mf" { three_mf(data)? } else { stl(data)? };
    // Printing files are Z-up: turned -90° about X.
    for part in &mut mesh.parts {
        for v in &mut part.vertices {
            let [x, y, z] = v.position;
            v.position = [x, z, -y];
            let [x, y, z] = v.normal;
            v.normal = [x, z, -y];
        }
    }
    Some(mesh)
}

fn stl(data: &[u8]) -> Option<Mesh> {
    let mut cursor = Cursor::new(data);
    let reader = stl_io::create_stl_reader(&mut cursor).ok()?;
    let mut vertices = Vec::new();
    for t in reader {
        let t = t.ok()?;
        flat(&mut vertices, t.vertices.map(|v| Vec3::from(v.0)), [WHITE; 3]);
    }
    Some(Mesh { parts: vec![grey(vertices)] })
}

fn obj_mesh(data: &[u8]) -> Option<Mesh> {
    let options = tobj::LoadOptions { triangulate: true, single_index: true, ..Default::default() };
    let (models, _) = tobj::load_obj_buf(&mut Cursor::new(data), &options, |_| Err(tobj::LoadError::OpenFileFailed)).ok()?;
    let mut vertices = Vec::new();
    for m in models {
        let m = m.mesh;
        let at = |i: u32| Vec3::new(m.positions[i as usize * 3], m.positions[i as usize * 3 + 1], m.positions[i as usize * 3 + 2]);
        for tri in m.indices.chunks_exact(3) {
            let p = [at(tri[0]), at(tri[1]), at(tri[2])];
            if m.normals.is_empty() {
                flat(&mut vertices, p, [WHITE; 3]);
                continue;
            }
            for (k, &i) in tri.iter().enumerate() {
                let i = i as usize * 3;
                let normal = [m.normals[i], m.normals[i + 1], m.normals[i + 2]];
                vertices.push(Vertex { position: p[k].into(), normal, color: WHITE, uv: [0., 0.] });
            }
        }
    }
    Some(Mesh { parts: vec![grey(vertices)] })
}

fn gltf_mesh(data: &[u8]) -> Option<Mesh> {
    let (doc, buffers, images) = gltf::import_slice(data).ok()?;
    let scene = doc.default_scene().or_else(|| doc.scenes().next())?;
    let mut parts = Vec::new();
    for node in scene.nodes() {
        gltf_node(&node, Mat4::IDENTITY, &buffers, &images, &mut parts);
    }
    Some(Mesh { parts })
}

fn gltf_node(node: &gltf::Node, parent: Mat4, buffers: &[gltf::buffer::Data], images: &[gltf::image::Data], parts: &mut Vec<Part>) {
    let world = parent * Mat4::from_cols_array_2d(&node.transform().matrix());
    if let Some(mesh) = node.mesh() {
        let normal_matrix = Mat3::from_mat4(world).inverse().transpose();
        let mirrored = world.determinant() < 0.;
        for primitive in mesh.primitives() {
            if primitive.mode() != gltf::mesh::Mode::Triangles {
                continue;
            }
            let reader = primitive.reader(|b| buffers.get(b.index()).map(|d| &d.0[..]));
            let Some(positions) = reader.read_positions() else { continue };
            let positions: Vec<Vec3> = positions.map(|p| world.transform_point3(Vec3::from(p))).collect();
            let normals: Option<Vec<Vec3>> = reader.read_normals().map(|n| n.map(|n| (normal_matrix * Vec3::from(n)).normalize_or_zero()).collect());
            let uvs: Option<Vec<[f32; 2]>> = reader.read_tex_coords(0).map(|t| t.into_f32().collect());
            let colors: Option<Vec<[f32; 4]>> = reader.read_colors(0).map(|c| c.into_rgba_f32().collect());
            let indices: Vec<u32> = match reader.read_indices() {
                Some(i) => i.into_u32().collect(),
                None => (0..positions.len() as u32).collect(),
            };
            let mut vertices = Vec::with_capacity(indices.len());
            for tri in indices.chunks_exact(3) {
                let tri = if mirrored { [tri[0], tri[2], tri[1]] } else { [tri[0], tri[1], tri[2]] }.map(|i| i as usize);
                let p = tri.map(|i| positions[i]);
                let face = (p[1] - p[0]).cross(p[2] - p[0]).normalize_or_zero();
                for (k, &i) in tri.iter().enumerate() {
                    vertices.push(Vertex {
                        position: p[k].into(),
                        normal: normals.as_ref().map_or(face, |n| n[i]).into(),
                        color: colors.as_ref().map_or(WHITE, |c| c[i]),
                        uv: uvs.as_ref().map_or([0., 0.], |t| t[i]),
                    });
                }
            }
            let material = primitive.material();
            let pbr = material.pbr_metallic_roughness();
            let picture = pbr.base_color_texture().and_then(|t| images.get(t.texture().source().index())).and_then(rgba_of);
            parts.push(Part {
                vertices,
                color: pbr.base_color_factor(),
                roughness: pbr.roughness_factor(),
                metalness: pbr.metallic_factor(),
                picture,
                double_sided: material.double_sided(),
            });
        }
    }
    for child in node.children() {
        gltf_node(&child, world, buffers, images, parts);
    }
}

/// A glTF picture as 8-bit RGBA.
fn rgba_of(i: &gltf::image::Data) -> Option<image::RgbaImage> {
    use gltf::image::Format;
    let px: Vec<u8> = match i.format {
        Format::R8G8B8A8 => i.pixels.clone(),
        Format::R8G8B8 => i.pixels.chunks_exact(3).flat_map(|c| [c[0], c[1], c[2], 255]).collect(),
        Format::R8G8 => i.pixels.chunks_exact(2).flat_map(|c| [c[0], c[0], c[0], c[1]]).collect(),
        Format::R8 => i.pixels.iter().flat_map(|&c| [c, c, c, 255]).collect(),
        _ => return None,
    };
    image::RgbaImage::from_raw(i.width, i.height, px)
}

// 3MF, as three.js's 3MFLoader reads it: every model part's objects by id (the root model last),
// colours from base materials and colour groups, components and build items with their transforms.

struct Tri3mf {
    v: [usize; 3],
    p: [Option<usize>; 3],
    pid: Option<String>,
}

struct Object3mf {
    pid: Option<String>,
    pindex: Option<usize>,
    vertices: Vec<Vec3>,
    triangles: Vec<Tri3mf>,
    components: Vec<(String, Mat4)>,
}

enum Resolved {
    Mesh(Vec<([Vec3; 3], [[f32; 4]; 3])>),
    Components(Vec<(String, Mat4)>),
}

/// A 3MF transform, "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32".
fn transform_of(s: &str) -> Mat4 {
    let t: Vec<f32> = s.split_whitespace().filter_map(|v| v.parse().ok()).collect();
    if t.len() < 12 {
        return Mat4::IDENTITY;
    }
    Mat4::from_cols_array(&[t[0], t[1], t[2], 0., t[3], t[4], t[5], 0., t[6], t[7], t[8], 0., t[9], t[10], t[11], 1.])
}

/// "#RRGGBB" or "#RRGGBBAA", linear.
fn color_of(s: &str) -> [f32; 4] {
    s.get(1..7).and_then(|h| u32::from_str_radix(h, 16).ok()).map_or(WHITE, linear)
}

fn three_mf(data: &[u8]) -> Option<Mesh> {
    let mut zip = zip::ZipArchive::new(Cursor::new(data)).ok()?;
    let names: Vec<String> = zip.file_names().map(String::from).collect();
    let is_model = |n: &str| n.starts_with("3D/") && n.ends_with(".model");
    let root = names.iter().filter(|n| is_model(n) && !n[3..].contains('/')).next_back()?.clone();
    let mut order: Vec<&String> = names.iter().filter(|n| is_model(n) && n[3..].contains('/')).collect();
    order.push(&root);
    let mut objects: HashMap<String, Resolved> = HashMap::new();
    let mut items = Vec::new();
    for name in order {
        let mut text = Vec::new();
        zip.by_name(name).ok()?.read_to_end(&mut text).ok()?;
        let built = model_part(&text, &mut objects)?;
        if *name == root {
            items = built;
        }
    }
    let mut vertices = Vec::new();
    for (id, transform) in items {
        emit(&id, transform, &objects, &mut vertices);
    }
    Some(Mesh { parts: vec![Part { vertices, color: WHITE, roughness: ROUGHNESS, metalness: METALNESS, picture: None, double_sided: false }] })
}

fn emit(id: &str, at: Mat4, objects: &HashMap<String, Resolved>, out: &mut Vec<Vertex>) {
    match objects.get(id) {
        Some(Resolved::Mesh(tris)) => {
            let mirrored = at.determinant() < 0.;
            for (p, c) in tris {
                let p = p.map(|v| at.transform_point3(v));
                if mirrored { flat(out, [p[0], p[2], p[1]], [c[0], c[2], c[1]]) } else { flat(out, p, *c) }
            }
        }
        Some(Resolved::Components(parts)) => {
            for (child, t) in parts {
                emit(child, at * *t, objects, out);
            }
        }
        None => {}
    }
}

/// One model part's objects, into `objects`; its build items.
fn model_part(text: &[u8], objects: &mut HashMap<String, Resolved>) -> Option<Vec<(String, Mat4)>> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(text);
    let mut buf = Vec::new();
    let mut materials: HashMap<String, Vec<[f32; 4]>> = HashMap::new();
    let mut groups: HashMap<String, Vec<[f32; 4]>> = HashMap::new();
    let mut raw: Vec<(String, Object3mf)> = Vec::new();
    let mut items = Vec::new();
    let mut group: Option<(bool, String)> = None;
    let mut in_build = false;
    loop {
        let event = reader.read_event_into(&mut buf).ok()?;
        let (e, open) = match &event {
            Event::Start(e) => (e, true),
            Event::Empty(e) => (e, false),
            Event::End(e) => {
                match e.local_name().as_ref() {
                    b"basematerials" | b"colorgroup" => group = None,
                    b"build" => in_build = false,
                    _ => {}
                }
                buf.clear();
                continue;
            }
            Event::Eof => break,
            _ => {
                buf.clear();
                continue;
            }
        };
        let attrs: HashMap<Vec<u8>, String> = e
            .attributes()
            .filter_map(|a| a.ok())
            .map(|a| (a.key.local_name().as_ref().to_vec(), String::from_utf8_lossy(&a.value).into_owned()))
            .collect();
        let get = |k: &[u8]| attrs.get(k);
        let num = |k: &[u8]| attrs.get(k).and_then(|v| v.trim().parse::<usize>().ok());
        let float = |k: &[u8]| attrs.get(k).and_then(|v| v.trim().parse::<f32>().ok()).unwrap_or(0.);
        match e.local_name().as_ref() {
            b"basematerials" | b"colorgroup" => {
                let is_group = e.local_name().as_ref() == b"colorgroup";
                let id = get(b"id").cloned().unwrap_or_default();
                if is_group { groups.entry(id.clone()).or_default() } else { materials.entry(id.clone()).or_default() };
                group = open.then_some((is_group, id));
            }
            b"base" => {
                if let Some((false, id)) = &group {
                    materials.entry(id.clone()).or_default().push(color_of(get(b"displaycolor").map_or("", |s| s)));
                }
            }
            b"color" => {
                if let Some((true, id)) = &group {
                    groups.entry(id.clone()).or_default().push(color_of(get(b"color").map_or("", |s| s)));
                }
            }
            b"object" => {
                let object = Object3mf { pid: get(b"pid").cloned(), pindex: num(b"pindex"), vertices: Vec::new(), triangles: Vec::new(), components: Vec::new() };
                raw.push((get(b"id").cloned().unwrap_or_default(), object));
            }
            b"vertex" => {
                if let Some((_, o)) = raw.last_mut() {
                    o.vertices.push(Vec3::new(float(b"x"), float(b"y"), float(b"z")));
                }
            }
            b"triangle" => {
                if let Some((_, o)) = raw.last_mut() {
                    let v = [num(b"v1").unwrap_or(0), num(b"v2").unwrap_or(0), num(b"v3").unwrap_or(0)];
                    o.triangles.push(Tri3mf { v, p: [num(b"p1"), num(b"p2"), num(b"p3")], pid: get(b"pid").cloned() });
                }
            }
            b"component" => {
                if let Some((_, o)) = raw.last_mut() {
                    o.components.push((get(b"objectid").cloned().unwrap_or_default(), get(b"transform").map_or(Mat4::IDENTITY, |t| transform_of(t))));
                }
            }
            b"build" => in_build = open,
            b"item" if in_build => {
                items.push((get(b"objectid").cloned().unwrap_or_default(), get(b"transform").map_or(Mat4::IDENTITY, |t| transform_of(t))));
            }
            _ => {}
        }
        buf.clear();
    }
    for (id, o) in raw {
        if !o.components.is_empty() && o.triangles.is_empty() {
            objects.insert(id, Resolved::Components(o.components));
            continue;
        }
        let at = |i: usize| o.vertices.get(i).copied().unwrap_or(Vec3::ZERO);
        let tris = o
            .triangles
            .iter()
            .map(|t| {
                let pid = t.pid.as_ref().or(o.pid.as_ref());
                let first = t.p[0].or(o.pindex);
                let colors = match pid {
                    Some(pid) if materials.contains_key(pid) => [materials[pid].get(first.unwrap_or(0)).copied().unwrap_or(WHITE); 3],
                    Some(pid) if groups.contains_key(pid) => {
                        let c = |i: Option<usize>| i.and_then(|i| groups[pid].get(i).copied()).unwrap_or(WHITE);
                        [c(first), c(t.p[1].or(first)), c(t.p[2].or(first))]
                    }
                    _ => [WHITE; 3],
                };
                (t.v.map(at), colors)
            })
            .collect();
        objects.insert(id, Resolved::Mesh(tris));
    }
    Some(items)
}

/// The picture a zip package (3MF) names as its thumbnail; none when it names none.
fn thumbnail_in(data: &[u8]) -> Option<Arc<Image>> {
    if !data.starts_with(b"PK") {
        return None;
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(data)).ok()?;
    let mut rels = String::new();
    zip.by_name("_rels/.rels").ok()?.read_to_string(&mut rels).ok()?;
    let mut reader = quick_xml::Reader::from_str(&rels);
    let target = loop {
        match reader.read_event().ok()? {
            quick_xml::events::Event::Empty(e) | quick_xml::events::Event::Start(e) if e.local_name().as_ref() == b"Relationship" => {
                let attr = |k: &[u8]| e.attributes().filter_map(|a| a.ok()).find(|a| a.key.as_ref() == k).map(|a| String::from_utf8_lossy(&a.value).into_owned());
                if attr(b"Type").is_some_and(|t| t.ends_with("/metadata/thumbnail")) {
                    break attr(b"Target")?;
                }
            }
            quick_xml::events::Event::Eof => return None,
            _ => {}
        }
    };
    let format = match extension(&target).as_str() {
        "png" => ImageFormat::Png,
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        _ => return None,
    };
    let mut bytes = Vec::new();
    zip.by_name(target.trim_start_matches('/')).ok()?.read_to_end(&mut bytes).ok()?;
    Some(Arc::new(Image::from_bytes(format, bytes)))
}

/// Centred on the origin; its size, as a radius.
fn centre(mesh: &mut Mesh) -> f32 {
    let (mut min, mut max) = (Vec3::splat(f32::INFINITY), Vec3::splat(f32::NEG_INFINITY));
    for v in mesh.parts.iter().flat_map(|p| &p.vertices) {
        min = min.min(v.position.into());
        max = max.max(v.position.into());
    }
    if min.x > max.x {
        return 1e-3;
    }
    let middle = (min + max) / 2.;
    for v in mesh.parts.iter_mut().flat_map(|p| &mut p.vertices) {
        v.position = (Vec3::from(v.position) - middle).into();
    }
    ((max - min).length() / 2.).max(1e-3)
}

/// Where the camera starts: framing it whole, from above and to the side.
fn home(radius: f32) -> Vec3 {
    let distance = radius / (FOV / 2.).to_radians().sin();
    Vec3::new(distance * 0.6, distance * 0.45, distance * 0.7)
}

/// Where a blob's light copy is (a model on the core); any other route, where it is.
fn light_of(route: &str) -> String {
    let (path, query) = route.split_once('?').map_or((route, None), |(p, q)| (p, Some(q)));
    let hash = path.strip_prefix("/blobs/").unwrap_or_default();
    let mut out = path.to_string();
    if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        out.push_str("/light");
    }
    if let Some(q) = query {
        out.push('?');
        out.push_str(q);
    }
    out
}

// The GPU.

const SHADER: &str = r#"
struct Globals { view_proj: mat4x4<f32>, eye: vec4<f32>, sun: vec4<f32> };
struct Part { color: vec4<f32>, surface: vec4<f32> };
@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> part: Part;
@group(1) @binding(1) var picture: texture_2d<f32>;
@group(1) @binding(2) var picture_sampler: sampler;

struct VertexIn {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec4<f32>,
    @location(3) uv: vec2<f32>,
};
struct VertexOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec4<f32>,
    @location(3) uv: vec2<f32>,
};

@vertex
fn vs(v: VertexIn) -> VertexOut {
    var out: VertexOut;
    out.clip = globals.view_proj * vec4<f32>(v.position, 1.0);
    out.world = v.position;
    out.normal = v.normal;
    out.color = v.color;
    out.uv = v.uv;
    return out;
}

const PI = 3.141592653589793;
// The hemisphere light (sky white, ground 0x404048, 2.2) and the sun (white, 1.6), linear.
const SKY = vec3<f32>(2.2, 2.2, 2.2);
const GROUND = vec3<f32>(0.11283, 0.11283, 0.14259);
const SUN = 1.6;

fn encoded(c: vec3<f32>) -> vec3<f32> {
    return select(1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3<f32>(0.0031308));
}

// MeshStandardMaterial under the two lights: Lambert diffuse, GGX specular from the sun.
@fragment
fn fs(in: VertexOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    var n = normalize(in.normal);
    if (!front) { n = -n; }
    let base = part.color * in.color * textureSample(picture, picture_sampler, in.uv);
    let roughness = clamp(part.surface.x, 0.0525, 1.0);
    let metalness = part.surface.y;
    let diffuse = base.rgb * (1.0 - metalness);
    let f0 = mix(vec3<f32>(0.04), base.rgb, metalness);
    let v = normalize(globals.eye.xyz - in.world);
    let l = globals.sun.xyz;
    let h = normalize(l + v);
    let nl = saturate(dot(n, l));
    let nv = saturate(dot(n, v));
    let nh = saturate(dot(n, h));
    let vh = saturate(dot(v, h));
    let a = roughness * roughness;
    let a2 = a * a;
    let fresnel = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - vh, 5.0);
    let gv = nl * sqrt(a2 + (1.0 - a2) * nv * nv);
    let gl = nv * sqrt(a2 + (1.0 - a2) * nl * nl);
    let visibility = 0.5 / max(gv + gl, 1e-6);
    let d = nh * nh * (a2 - 1.0) + 1.0;
    let distribution = a2 / (PI * d * d);
    let direct = nl * SUN * (diffuse / PI + fresnel * visibility * distribution);
    let hemisphere = mix(GROUND, SKY, 0.5 * n.y + 0.5) * diffuse / PI;
    return vec4<f32>(encoded(direct + hemisphere), 1.0);
}
"#;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Globals {
    view_proj: [[f32; 4]; 4],
    eye: [f32; 4],
    sun: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct PartUniform {
    color: [f32; 4],
    surface: [f32; 4],
}

/// The app's one GPU device: every picture and the live model are drawn with it off screen.
struct Gpu {
    name: String,
    device: wgpu::Device,
    queue: wgpu::Queue,
    culled: wgpu::RenderPipeline,
    both_sides: wgpu::RenderPipeline,
    globals_layout: wgpu::BindGroupLayout,
    part_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    white: wgpu::TextureView,
}

base::kept! {
    static GPU: OnceLock<Option<Gpu>> = OnceLock::new();
}

fn gpu() -> Option<&'static Gpu> {
    GPU.get_or_init(Gpu::new).as_ref()
}

/// A model's buffers on the GPU, while it's drawn.
struct Uploaded {
    parts: Vec<(wgpu::Buffer, u32, wgpu::BindGroup, bool)>,
}

/// What a draw of one size draws into and reads back from.
struct Targets {
    size: (u32, u32),
    msaa: wgpu::TextureView,
    resolved: wgpu::Texture,
    depth: wgpu::TextureView,
    readback: wgpu::Buffer,
    row: u32,
    globals: wgpu::Buffer,
    globals_bind: wgpu::BindGroup,
}

impl Gpu {
    fn new() -> Option<Gpu> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::METAL, ..wgpu::InstanceDescriptor::new_without_display_handle() });
        let adapter = futures::executor::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .ok()?;
        let (device, queue) = futures::executor::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("models"),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .ok()?;
        device.on_uncaptured_error(Arc::new(|e| log::error!("model drawing: {e}")));
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("model"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        let uniform = |binding, visibility| wgpu::BindGroupLayoutEntry {
            binding,
            visibility,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let globals_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("globals"),
            entries: &[uniform(0, wgpu::ShaderStages::VERTEX_FRAGMENT)],
        });
        let part_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("part"),
            entries: &[
                uniform(0, wgpu::ShaderStages::FRAGMENT),
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("model"),
            bind_group_layouts: &[Some(&globals_layout), Some(&part_layout)],
            immediate_size: 0,
        });
        let attributes = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x4, 3 => Float32x2];
        let pipeline = |cull_mode| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("model"),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[Some(wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<Vertex>() as u64,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &attributes,
                    })],
                },
                primitive: wgpu::PrimitiveState { cull_mode, ..Default::default() },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: DEPTH,
                    depth_write_enabled: Some(true),
                    depth_compare: Some(wgpu::CompareFunction::Less),
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: wgpu::MultisampleState { count: SAMPLES, ..Default::default() },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format: FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        let culled = pipeline(Some(wgpu::Face::Back));
        let both_sides = pipeline(None);
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("picture"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let white = Self::picture(&device, &queue, &image::RgbaImage::from_pixel(1, 1, image::Rgba([255; 4])));
        Some(Gpu { name: adapter.get_info().name, device, queue, culled, both_sides, globals_layout, part_layout, sampler, white })
    }

    fn picture(device: &wgpu::Device, queue: &wgpu::Queue, p: &image::RgbaImage) -> wgpu::TextureView {
        device
            .create_texture_with_data(
                queue,
                &wgpu::TextureDescriptor {
                    label: Some("picture"),
                    size: wgpu::Extent3d { width: p.width(), height: p.height(), depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
                wgpu::util::TextureDataOrder::LayerMajor,
                p.as_raw(),
            )
            .create_view(&Default::default())
    }

    fn upload(&self, mesh: &Mesh) -> Uploaded {
        let parts = mesh
            .parts
            .iter()
            .filter(|p| !p.vertices.is_empty())
            .map(|p| {
                let buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("vertices"),
                    contents: bytemuck::cast_slice(&p.vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                });
                let uniform = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("part"),
                    contents: bytemuck::bytes_of(&PartUniform { color: p.color, surface: [p.roughness, p.metalness, 0., 0.] }),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                let picture = p.picture.as_ref().map(|i| Self::picture(&self.device, &self.queue, i));
                let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("part"),
                    layout: &self.part_layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(picture.as_ref().unwrap_or(&self.white)) },
                        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                    ],
                });
                (buffer, p.vertices.len() as u32, bind, p.double_sided)
            })
            .collect();
        Uploaded { parts }
    }

    fn targets(&self, (w, h): (u32, u32)) -> Targets {
        let texture = |samples, format, usage| {
            self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("model frame"),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: samples,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage,
                view_formats: &[],
            })
        };
        let msaa = texture(SAMPLES, FORMAT, wgpu::TextureUsages::RENDER_ATTACHMENT).create_view(&Default::default());
        let resolved = texture(1, FORMAT, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC);
        let depth = texture(SAMPLES, DEPTH, wgpu::TextureUsages::RENDER_ATTACHMENT).create_view(&Default::default());
        let row = (w * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("model readback"),
            size: (row * h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let globals = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("globals"),
            size: std::mem::size_of::<Globals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let globals_bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("globals"),
            layout: &self.globals_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: globals.as_entire_binding() }],
        });
        Targets { size: (w, h), msaa, resolved, depth, readback, row, globals, globals_bind }
    }

    /// The model seen from `eye`, looking at its middle, as a picture gpui draws (BGRA, straight alpha).
    fn draw(&self, model: &Uploaded, eye: Vec3, aspect: f32, radius: f32, size: (u32, u32), targets: &mut Option<Targets>) -> Arc<RenderImage> {
        if targets.as_ref().is_none_or(|t| t.size != size) {
            *targets = Some(self.targets(size));
        }
        let t = targets.as_ref().expect("targets");
        let view = glam::camera::rh::view::look_at_mat4(eye, Vec3::ZERO, Vec3::Y);
        let projection = glam::camera::rh::proj::directx::perspective(FOV.to_radians(), aspect, radius / 100., radius * 100.);
        let sun = eye.normalize_or_zero();
        let globals = Globals { view_proj: (projection * view).to_cols_array_2d(), eye: eye.extend(1.).into(), sun: sun.extend(0.).into() };
        self.queue.write_buffer(&t.globals, 0, bytemuck::bytes_of(&globals));
        let mut encoder = self.device.create_command_encoder(&Default::default());
        let resolved = t.resolved.create_view(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("model"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &t.msaa,
                    depth_slice: None,
                    resolve_target: Some(&resolved),
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Discard },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &t.depth,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.), store: wgpu::StoreOp::Discard }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, &t.globals_bind, &[]);
            for (buffer, count, bind, double_sided) in &model.parts {
                pass.set_pipeline(if *double_sided { &self.both_sides } else { &self.culled });
                pass.set_bind_group(1, bind, &[]);
                pass.set_vertex_buffer(0, buffer.slice(..));
                pass.draw(0..*count, 0..1);
            }
        }
        let (w, h) = size;
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &t.resolved, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &t.readback, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(t.row), rows_per_image: Some(h) } },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.queue.submit([encoder.finish()]);
        let slice = t.readback.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        if let Ok(mapped) = slice.get_mapped_range() {
            for (y, row) in pixels.chunks_exact_mut((w * 4) as usize).enumerate() {
                let start = y * t.row as usize;
                row.copy_from_slice(&mapped[start..start + (w * 4) as usize]);
            }
        }
        t.readback.unmap();
        // The edges come back premultiplied; gpui draws straight alpha.
        for px in pixels.chunks_exact_mut(4) {
            let a = px[3] as u32;
            if a > 0 && a < 255 {
                for c in &mut px[..3] {
                    *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        let frame = image::Frame::new(image::RgbaImage::from_raw(w, h, pixels).expect("frame"));
        Arc::new(RenderImage::new(vec![frame]))
    }
}

// Loading.

enum Source {
    Core(String),
    File(PathBuf),
}

enum Picture {
    Thumbnail(Arc<Image>),
    Drawn(Arc<RenderImage>),
}

struct Loaded {
    mesh: Mesh,
    /// Its size; the camera's place framing it whole comes from it.
    radius: f32,
    /// A picture of it at rest.
    picture: Picture,
}

/// The model read, centred and pictured, off the window's thread.
fn build(data: Vec<u8>, name: &str) -> Option<Loaded> {
    // The device is made with the first model, so one the system refuses is that model's error.
    let gpu = gpu()?;
    let mut mesh = parse(&data, name)?;
    let radius = centre(&mut mesh);
    let picture = match thumbnail_in(&data) {
        Some(t) => Picture::Thumbnail(t),
        None => Picture::Drawn(gpu.draw(&gpu.upload(&mesh), home(radius), PICTURE.0 as f32 / PICTURE.1 as f32, radius, PICTURE, &mut None)),
    };
    Some(Loaded { mesh, radius, picture })
}

async fn load(source: &Source, name: &str, cx: &mut AsyncApp) -> Result<Loaded, &'static str> {
    let data = match source {
        Source::Core(route) => {
            let job = cx.update(|cx| cx.global::<Net>().fetch_status(light_of(route)));
            match job.await {
                Ok(Ok(data)) => data,
                Ok(Err(404)) => return Err("Gone"),
                _ => return Err(CANT),
            }
        }
        Source::File(path) => std::fs::read(path).map_err(|_| CANT)?,
    };
    let name = name.to_string();
    cx.background_spawn(async move { build(data, &name).ok_or(CANT) }).await
}

enum Load {
    Loading,
    Failed(&'static str),
    Ready(Arc<Loaded>),
}

/// Loaded models by route, and the one that's live.
#[derive(Default)]
struct Models {
    views: HashMap<String, Entity<ModelView>>,
    live: Option<WeakEntity<ModelView>>,
    sweeping: bool,
}

impl Global for Models {}

impl Models {
    fn view(route: &str, name: &str, cx: &mut App) -> Entity<ModelView> {
        if let Some(v) = cx.default_global::<Models>().views.get(route) {
            return v.clone();
        }
        // One sent from here goes on as the view it had while it was being sent.
        let sent = route.strip_prefix("/blobs/").and_then(crate::own::of_blob).map(|p| p.to_string_lossy().to_string());
        if let Some(v) = sent.and_then(|k| cx.global::<Models>().views.get(&k).cloned()) {
            cx.global_mut::<Models>().views.insert(route.to_string(), v.clone());
            return v;
        }
        Self::sweep(cx);
        let source = if crate::own::holds(route) { Source::File(PathBuf::from(route)) } else { Source::Core(route.to_string()) };
        let view = cx.new(|cx| ModelView::new(route, name, source, cx));
        cx.global_mut::<Models>().views.insert(route.to_string(), view.clone());
        view
    }

    /// Every minute, lets go of models no one has drawn for ten.
    fn sweep(cx: &mut App) {
        if std::mem::replace(&mut cx.default_global::<Models>().sweeping, true) {
            return;
        }
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(60)).await;
                cx.update(|cx| {
                    let views: Vec<(String, Entity<ModelView>)> = cx.global::<Models>().views.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                    for (route, view) in views {
                        let v = view.read(cx);
                        if v.live.is_some() || v.seen.elapsed() < KEEP {
                            continue;
                        }
                        let drawn = match &v.load {
                            Load::Ready(l) => match &l.picture {
                                Picture::Drawn(p) => Some(p.clone()),
                                Picture::Thumbnail(_) => None,
                            },
                            _ => None,
                        };
                        if let Some(p) = drawn {
                            cx.drop_image(p, None);
                        }
                        cx.global_mut::<Models>().views.remove(&route);
                    }
                });
            }
        })
        .detach();
    }
}

/// The model while it's live: on the GPU, its camera turning as OrbitControls turns one.
struct Live {
    model: Uploaded,
    targets: Option<Targets>,
    eye: Vec3,
    /// The turn still to come, OrbitControls' spherical delta (theta, phi).
    delta: (f32, f32),
    /// Where the camera was when it last moved.
    last: Vec3,
    drag: Option<Point<Pixels>>,
    height: f32,
    /// Moved since its frame was drawn.
    dirty: bool,
    frame: Option<Arc<RenderImage>>,
    /// The measuring run's frames: their gaps and draw times, in ms.
    measured: Vec<(f64, f64)>,
    painted: Option<Instant>,
}

impl Live {
    fn rotate(&mut self, left: f32, up: f32) {
        self.delta.0 -= left;
        self.delta.1 -= up;
    }

    /// OrbitControls' update with damping: a step of the turn still to come; whether it moved.
    fn update(&mut self) -> bool {
        let r = self.eye.length();
        let mut theta = self.eye.x.atan2(self.eye.z);
        let mut phi = (self.eye.y / r).clamp(-1., 1.).acos();
        theta += self.delta.0 * DAMPING;
        phi = (phi + self.delta.1 * DAMPING).clamp(EPS, PI - EPS);
        self.eye = Vec3::new(r * phi.sin() * theta.sin(), r * phi.cos(), r * phi.sin() * theta.cos());
        self.delta.0 *= 1. - DAMPING;
        self.delta.1 *= 1. - DAMPING;
        let turned = self.last.normalize().angle_between(self.eye.normalize());
        let moved = self.last.distance_squared(self.eye) > EPS || turned * turned > EPS;
        if moved {
            self.last = self.eye;
        }
        moved
    }
}

pub struct ModelView {
    route: String,
    name: String,
    load: Load,
    seen: Instant,
    live: Option<Live>,
    /// Where the camera was left, so it's as it was when it's live again.
    view: Option<Vec3>,
    /// The measuring run: live as soon as it's in, turning on its own.
    auto: bool,
    /// Full screen: live as soon as it's in, square-cornered, the wheel zooming it.
    full: bool,
}

/// A 3D file full screen: a view of its own, live as soon as it's in, from where the chat's was
/// left; the chat's model as it's loaded, when it is.
pub fn full_view(route: &str, name: &str, cx: &mut App) -> Entity<ModelView> {
    let chat = Models::view(route, name, cx);
    let (loaded, view) = {
        let c = chat.read(cx);
        let loaded = match &c.load {
            Load::Ready(l) => Some(l.clone()),
            _ => None,
        };
        (loaded, c.live.as_ref().map(|l| l.eye).or(c.view))
    };
    let full = cx.new(|cx| {
        let mut v = match loaded {
            Some(l) => ModelView { route: route.to_string(), name: name.to_string(), load: Load::Ready(l), seen: Instant::now(), live: None, view, auto: false, full: true },
            None => ModelView::new(route, name, Source::Core(route.to_string()), cx),
        };
        v.full = true;
        v
    });
    full.update(cx, |v, cx| v.wake(None, cx));
    full
}

impl ModelView {
    fn new(route: &str, name: &str, source: Source, cx: &mut Context<Self>) -> Self {
        cx.observe(&Beat::entity(cx), |this: &mut ModelView, _, cx| {
            if matches!(this.load, Load::Loading) {
                cx.notify();
            }
        })
        .detach();
        let name = name.to_string();
        let loading = name.clone();
        cx.spawn(async move |this, cx| {
            let mut got = load(&source, &loading, cx).await;
            if got.is_err() {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                got = load(&source, &loading, cx).await;
            }
            this.update(cx, |v, cx| {
                v.load = match got {
                    Ok(l) => Load::Ready(Arc::new(l)),
                    Err(m) => Load::Failed(m),
                };
                if v.auto || v.full {
                    v.wake(None, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        ModelView { route: route.to_string(), name: name.to_string(), load: Load::Loading, seen: Instant::now(), live: None, view: None, auto: false, full: false }
    }

    /// Makes this the live model; the last one rests.
    fn wake(&mut self, window: Option<&mut Window>, cx: &mut Context<Self>) {
        if self.live.is_some() {
            return;
        }
        let (Load::Ready(loaded), Some(gpu)) = (&self.load, gpu()) else { return };
        let eye = self.view.unwrap_or(home(loaded.radius));
        let model = gpu.upload(&loaded.mesh);
        let me = cx.entity();
        let last = cx.default_global::<Models>().live.replace(me.downgrade());
        if let Some(last) = last.and_then(|l| l.upgrade()).filter(|l| l.entity_id() != me.entity_id()) {
            last.update(cx, |l, cx| l.rest(window, cx));
        }
        self.live = Some(Live {
            model,
            targets: None,
            eye,
            delta: (0., 0.),
            last: eye,
            drag: None,
            height: 1.,
            dirty: true,
            frame: None,
            measured: Vec::new(),
            painted: None,
        });
        cx.notify();
    }

    /// Back to its picture, its buffers off the GPU until it's live again.
    fn rest(&mut self, window: Option<&mut Window>, cx: &mut Context<Self>) {
        let Some(live) = self.live.take() else { return };
        self.view = Some(live.eye);
        if let Some(frame) = live.frame {
            cx.drop_image(frame, window);
        }
        cx.notify();
    }

    fn zoom(&mut self, by: f32, cx: &mut Context<Self>) {
        let (Load::Ready(loaded), Some(live)) = (&self.load, &mut self.live) else { return };
        let r = loaded.radius;
        let distance = (live.eye.length() * by).clamp(r * 0.3, r * 30.);
        live.eye = live.eye.normalize() * distance;
        live.dirty = true;
        cx.notify();
    }

    fn drag_to(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(live) = &mut self.live else { return };
        let Some(from) = live.drag.replace(at) else { return };
        let (dx, dy) = (f32::from(at.x - from.x), f32::from(at.y - from.y));
        // Both by the height, as OrbitControls does.
        live.rotate(TAU * dx / live.height, TAU * dy / live.height);
        live.update();
        live.dirty = true;
        cx.notify();
    }

    /// Draws the live model into `bounds` at the screen's pixel ratio, and again each frame while
    /// it's still turning.
    fn paint_live(&mut self, bounds: Bounds<Pixels>, corners: Corners<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let (Load::Ready(loaded), Some(live), Some(gpu)) = (&self.load, &mut self.live, gpu()) else { return };
        if live.drag.is_some() {
            let me = cx.entity().downgrade();
            window.on_mouse_event({
                let me = me.clone();
                move |e: &MouseMoveEvent, phase, _, cx| {
                    if phase == DispatchPhase::Bubble {
                        me.update(cx, |v, cx| v.drag_to(e.position, cx)).ok();
                    }
                }
            });
            window.on_mouse_event(move |e: &MouseUpEvent, phase, _, cx| {
                if phase == DispatchPhase::Bubble && e.button == MouseButton::Left {
                    me.update(cx, |v, cx| {
                        if let Some(live) = &mut v.live {
                            live.drag = None;
                        }
                        cx.notify();
                    })
                    .ok();
                }
            });
        }
        live.height = f32::from(bounds.size.height).max(1.);
        let scale = window.scale_factor();
        let size = ((f32::from(bounds.size.width) * scale).round().max(1.) as u32, (f32::from(bounds.size.height) * scale).round().max(1.) as u32);
        if self.auto {
            live.rotate(TAU / 300., 0.);
        }
        let moving = live.update();
        let stale = live.targets.as_ref().is_none_or(|t| t.size != size);
        if moving || live.dirty || stale || live.frame.is_none() {
            live.dirty = false;
            let started = Instant::now();
            let aspect = f32::from(bounds.size.width) / f32::from(bounds.size.height).max(1.);
            let frame = gpu.draw(&live.model, live.eye, aspect, loaded.radius, size, &mut live.targets);
            let drawn = started.elapsed().as_secs_f64() * 1000.;
            let _ = window.paint_image(bounds, bounds, corners, frame.clone(), 0, false);
            if let Some(last) = live.frame.replace(frame) {
                let _ = window.drop_image(last);
            }
            if self.auto {
                let now = Instant::now();
                if let Some(at) = live.painted.replace(now) {
                    live.measured.push(((now - at).as_secs_f64() * 1000., drawn));
                }
                if live.measured.len() == 330 {
                    report(&live.measured[30..], loaded, size, gpu, live.frame.as_ref());
                    cx.quit();
                }
            }
        } else if let Some(frame) = &live.frame {
            let _ = window.paint_image(bounds, bounds, corners, frame.clone(), 0, false);
        }
        if moving || self.auto {
            window.request_animation_frame();
        }
    }
}

impl Render for ModelView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.seen = Instant::now();
        let l = Look::get(cx);
        // In a chat it's the top of a rounded frame with a hairline round it: gpui clips a frame's
        // children to its box, not its corners, so the picture takes the frame's top corners itself.
        let r = if self.full { px(0.) } else { u(18.).to_pixels(window.rem_size()) - px(1.) };
        let corners = Corners { top_left: r, top_right: r, ..Default::default() };
        let (route, name, full) = (self.route.clone(), self.name.clone(), self.full);
        // A click that didn't turn it opens it full screen.
        let open = move |e: &ClickEvent, window: &mut Window, cx: &mut App| {
            let (Some(at), false) = (e.mouse_position(), full) else { return };
            let from = match e {
                ClickEvent::Mouse(m) => m.down.position,
                _ => at,
            };
            if f32::from(at.x - from.x).hypot(f32::from(at.y - from.y)) < 4. {
                let item = crate::viewer::Item { route: route.clone(), name: name.clone(), kind: String::new(), blob: None };
                crate::viewer::open(vec![item], 0, window, cx);
            }
        };
        let base = div().id(ElementId::Name(format!("model:{}", self.route).into())).size_full().on_click(open);
        match &self.load {
            Load::Failed(message) => base
                .flex()
                .items_center()
                .justify_center()
                .gap(u(8.))
                .text_size(u(12.))
                .text_color(l.ink2)
                .child(marks::stop(px(12.), &l))
                .child(*message)
                .into_any_element(),
            Load::Loading => base
                .flex()
                .items_center()
                .justify_center()
                .child(svg().path(format!("spin/{}.svg", Beat::step(cx) % 8)).flex_none().size(px(12.)).text_color(l.ink3))
                .into_any_element(),
            Load::Ready(loaded) if self.live.is_none() => {
                let source = match &loaded.picture {
                    Picture::Thumbnail(t) => ImageSource::from(t.clone()),
                    Picture::Drawn(d) => ImageSource::Render(d.clone()),
                };
                base.cursor_grab()
                    .on_hover(cx.listener(|this, hovered: &bool, window, cx| {
                        if *hovered {
                            this.wake(Some(window), cx);
                        }
                    }))
                    .on_mouse_down(MouseButton::Left, cx.listener(|this, _: &MouseDownEvent, window, cx| this.wake(Some(window), cx)))
                    .child(img(source).size_full().object_fit(ObjectFit::Contain).rounded_t(r))
                    .into_any_element()
            }
            Load::Ready(_) => {
                let me = cx.entity();
                let dragging = self.live.as_ref().is_some_and(|l| l.drag.is_some());
                base.cursor_grab()
                    .when(dragging, |d| d.cursor_grabbing())
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, e: &MouseDownEvent, _, cx| {
                            if let Some(live) = &mut this.live {
                                live.drag = Some(e.position);
                                cx.notify();
                            }
                        }),
                    )
                    // A scroll scrolls the chat: only a pinch zooms, or a wheel with Control held;
                    // full screen, the wheel too.
                    .on_pinch(cx.listener(|this, e: &PinchEvent, _, cx| {
                        this.zoom(1. / (1. + e.delta).max(1e-3), cx);
                        cx.stop_propagation();
                    }))
                    .on_scroll(cx.listener(|this, e: &ScrollEvent, window, cx| {
                        if e.modifiers.control || this.full {
                            let dy = f32::from(e.delta.pixel_delta(window.line_height()).y);
                            this.zoom((-dy * 0.01).exp(), cx);
                            cx.stop_propagation();
                        }
                    }))
                    .child(canvas(|_, _, _| {}, move |bounds, (), window, cx| me.update(cx, |v, cx| v.paint_live(bounds, corners, window, cx))).size_full())
                    .into_any_element()
            }
        }
    }
}

// Measuring: `SWITCH_GPUI_MODEL=<file>` opens the model live in a window, turning on its own, and
// prints its frame times; `SWITCH_GPUI_MODEL_ZOOM=2` draws it twice the size, as many pixels as a
// Retina screen's.

fn percentile(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(f64::total_cmp);
    v[((v.len() - 1) as f64 * p).round() as usize]
}

fn report(measured: &[(f64, f64)], loaded: &Loaded, size: (u32, u32), gpu: &Gpu, frame: Option<&Arc<RenderImage>>) {
    let mut gaps: Vec<f64> = measured.iter().map(|m| m.0).collect();
    let mut draws: Vec<f64> = measured.iter().map(|m| m.1).collect();
    eprintln!(
        "model: {} triangles at {}×{} px on {}; over {} frames: frame gap p50 {:.2} ms, p95 {:.2} ms; draw and read back p50 {:.2} ms, p95 {:.2} ms",
        loaded.mesh.triangles(),
        size.0,
        size.1,
        gpu.name,
        measured.len(),
        percentile(&mut gaps, 0.5),
        percentile(&mut gaps, 0.95),
        percentile(&mut draws, 0.5),
        percentile(&mut draws, 0.95),
    );
    let (Ok(dir), Some(frame)) = (std::env::var("SWITCH_GPUI_SHOT"), frame) else { return };
    let Some(bytes) = frame.as_bytes(0) else { return };
    let rgba: Vec<u8> = bytes.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0], p[3]]).collect();
    let (w, h) = (frame.size(0).width.0 as u32, frame.size(0).height.0 as u32);
    if let Some(i) = image::RgbaImage::from_raw(w, h, rgba) {
        let path = format!("{dir}/model.png");
        if i.save(&path).is_ok() {
            eprintln!("model: {path}");
        }
    }
}

struct Measure {
    route: String,
    name: String,
}

impl Render for Measure {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        let zoom: f32 = std::env::var("SWITCH_GPUI_MODEL_ZOOM").ok().and_then(|z| z.parse().ok()).unwrap_or(1.);
        window.set_rem_size(px(16. * zoom));
        div().size_full().bg(l.bg).flex().items_center().justify_center().child(model_view(&self.route, &self.name, ModelSize::Chat, window, cx))
    }
}

pub fn measure(path: String, cx: &mut App) {
    cx.set_global(Look::of(&crate::theme::Held::theme(cx), true));
    Beat::init(cx);
    let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let view = cx.new(|cx| {
        let mut v = ModelView::new(&path, &name, Source::File(PathBuf::from(&path)), cx);
        v.auto = true;
        v
    });
    cx.default_global::<Models>().views.insert(path.clone(), view);
    let bounds = Bounds::centered(None, gpui::size(px(960.), px(720.)), cx);
    let _ = cx.open_window(
        gpui::WindowOptions { window_bounds: Some(gpui::WindowBounds::Windowed(bounds)), ..Default::default() },
        |_, cx| cx.new(|_| Measure { route: path, name }),
    );
    cx.activate(true);
}
