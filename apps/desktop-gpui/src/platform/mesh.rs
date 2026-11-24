//! A 3MF's build as a binary STL, for Preview, which opens STL and OBJ but not 3MF (the desktop's
//! `bun/mesh.ts`). A 3MF is a zip of XML models: objects are meshes or components of other objects
//! (maybe in other model files), placed by the build's items, each with a 3x4 transform.

use std::collections::HashMap;
use std::io::Read;
use std::sync::LazyLock;

use regex_lite::Regex;

type Matrix = [f64; 12];

const IDENTITY: Matrix = [1., 0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0.];

static ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?P<key>[\w:]+)="(?P<value>[^"]*)""#).expect("regex"));
static OBJECT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<object\b(?P<tag>[^>]*)>(?P<body>.*?)</object>").expect("regex"));
static VERTEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<vertex\b(?P<tag>[^>]*)/>").expect("regex"));
static TRIANGLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<triangle\b(?P<tag>[^>]*)/>").expect("regex"));
static COMPONENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<component\b(?P<tag>[^>]*)/>").expect("regex"));
static RELATIONSHIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<Relationship\b(?P<tag>[^>]*)/>").expect("regex"));
static ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<item\b(?P<tag>[^>]*)/>").expect("regex"));

fn attrs(tag: &str) -> HashMap<String, String> {
    ATTR.captures_iter(tag).map(|c| (c["key"].to_string(), c["value"].to_string())).collect()
}

fn matrix_of(said: Option<&String>) -> Matrix {
    let n: Vec<f64> = said.map(|s| s.split_whitespace().map(|x| x.parse().unwrap_or(f64::NAN)).collect()).unwrap_or_default();
    if n.len() == 12 && n.iter().all(|x| x.is_finite()) { n.try_into().unwrap_or(IDENTITY) } else { IDENTITY }
}

/// `a` then `b`, as 3MF composes them (row vectors).
fn then(a: &Matrix, b: &Matrix) -> Matrix {
    // Each as a 4x4 whose last column is 0, 0, 0, 1.
    let at = |m: &Matrix, r: usize, c: usize| if c == 3 { if r == 3 { 1. } else { 0. } } else { m[r * 3 + c] };
    let mut out = [0.; 12];
    for r in 0..4 {
        for c in 0..3 {
            out[r * 3 + c] = (0..4).map(|k| at(a, r, k) * at(b, k, c)).sum();
        }
    }
    out
}

fn apply(m: &Matrix, x: f64, y: f64, z: f64) -> [f64; 3] {
    [
        x * m[0] + y * m[3] + z * m[6] + m[9],
        x * m[1] + y * m[4] + z * m[7] + m[10],
        x * m[2] + y * m[5] + z * m[8] + m[11],
    ]
}

enum Thing {
    Mesh { vertices: Vec<f64>, triangles: Vec<usize> },
    Parts(Vec<(String, Matrix)>),
}

fn key_of(file: &str, id: &str) -> String {
    format!("{file}#{id}")
}

/// Each object in one model file, by its key.
fn objects_in(file: &str, xml: &str, into: &mut HashMap<String, Thing>) {
    for m in OBJECT.captures_iter(xml) {
        let id = attrs(&m["tag"]).get("id").cloned().unwrap_or_default();
        let body = &m["body"];
        if body.contains("<mesh") {
            let mut vertices = vec![];
            for v in VERTEX.captures_iter(body) {
                let a = attrs(&v["tag"]);
                for k in ["x", "y", "z"] {
                    vertices.push(a.get(k).and_then(|x| x.parse().ok()).unwrap_or(f64::NAN));
                }
            }
            let mut triangles = vec![];
            for t in TRIANGLE.captures_iter(body) {
                let a = attrs(&t["tag"]);
                for k in ["v1", "v2", "v3"] {
                    triangles.push(a.get(k).and_then(|x| x.parse().ok()).unwrap_or(usize::MAX));
                }
            }
            into.insert(key_of(file, &id), Thing::Mesh { vertices, triangles });
        } else {
            let parts = COMPONENT
                .captures_iter(body)
                .map(|c| {
                    let a = attrs(&c["tag"]);
                    (key_of(a.get("p:path").map(String::as_str).unwrap_or(file), a.get("objectid").map(String::as_str).unwrap_or("")), matrix_of(a.get("transform")))
                })
                .collect();
            into.insert(key_of(file, &id), Thing::Parts(parts));
        }
    }
}

/// The model's triangles, placed, as a binary STL; None when it holds none.
pub fn three_mf_to_stl(zip: &[u8]) -> Option<Vec<u8>> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip)).ok()?;
    let mut files: HashMap<String, String> = HashMap::new();
    for i in 0..archive.len() {
        let Ok(mut f) = archive.by_index(i) else { continue };
        let name = f.name().to_string();
        if name.ends_with(".model") || name == "_rels/.rels" {
            let mut text = String::new();
            if f.read_to_string(&mut text).is_ok() {
                files.insert(name, text);
            }
        }
    }
    let text = |name: &str| files.get(name.trim_start_matches('/')).cloned().unwrap_or_default();
    let rels = text("_rels/.rels");
    let root_rel = RELATIONSHIP.captures_iter(&rels).map(|m| attrs(&m["tag"])).find(|a| a.get("Type").is_some_and(|t| t.ends_with("/3dmodel")));
    let root = format!("/{}", root_rel.and_then(|a| a.get("Target").cloned()).unwrap_or_else(|| "/3D/3dmodel.model".into()).trim_start_matches('/'));
    let mut objects = HashMap::new();
    for (name, xml) in &files {
        if name.ends_with(".model") {
            objects_in(&format!("/{name}"), xml, &mut objects);
        }
    }
    let mut out: Vec<f64> = vec![];
    fn place(objects: &HashMap<String, Thing>, key: &str, m: &Matrix, depth: usize, out: &mut Vec<f64>) {
        let Some(thing) = objects.get(key) else { return };
        if depth > 16 {
            return;
        }
        match thing {
            Thing::Parts(parts) => {
                for (k, t) in parts {
                    place(objects, k, &then(t, m), depth + 1, out);
                }
            }
            Thing::Mesh { vertices, triangles } => {
                for &i in triangles {
                    let v = |k: usize| i.checked_mul(3).and_then(|b| vertices.get(b + k)).copied().unwrap_or(0.);
                    out.extend(apply(m, v(0), v(1), v(2)));
                }
            }
        }
    }
    for m in ITEM.captures_iter(&text(&root)) {
        let a = attrs(&m["tag"]);
        place(&objects, &key_of(a.get("p:path").map(String::as_str).unwrap_or(&root), a.get("objectid").map(String::as_str).unwrap_or("")), &matrix_of(a.get("transform")), 0, &mut out);
    }
    let count = out.len() / 9;
    if count == 0 {
        return None;
    }
    let mut stl = vec![0u8; 84 + count * 50];
    stl[80..84].copy_from_slice(&(count as u32).to_le_bytes());
    for t in 0..count {
        let p = |k: usize| out[t * 9 + k];
        let (ux, uy, uz) = (p(3) - p(0), p(4) - p(1), p(5) - p(2));
        let (vx, vy, vz) = (p(6) - p(0), p(7) - p(1), p(8) - p(2));
        let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let len = if len == 0. || !len.is_finite() { 1. } else { len };
        let at = 84 + t * 50;
        for k in 0..3 {
            stl[at + k * 4..at + k * 4 + 4].copy_from_slice(&((n[k] / len) as f32).to_le_bytes());
        }
        for k in 0..9 {
            stl[at + 12 + k * 4..at + 16 + k * 4].copy_from_slice(&(p(k) as f32).to_le_bytes());
        }
    }
    Some(stl)
}
