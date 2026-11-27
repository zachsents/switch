//! Pictures from the core's blobs (a message's files, a space's cover, an ask's) and from files kept
//! on this Mac (a chip's), decoded off the main thread at the size they're drawn, never the
//! photo's own: a 12-megapixel photo drawn 240 points tall is kept at 720 pixels. What's
//! decoded is kept in a cache bounded by bytes, least recently drawn out first, its texture freed
//! from every window's atlas as it goes, but never one drawn in the last second: what's on screen
//! stays past the bound (a row of ten square pictures on a Retina screen is 58 MB) rather than
//! each decode putting out one still drawn, which shows its empty box and decodes again, putting
//! out the next. The fetched bytes are kept in another, so a picture scrolled back to decodes
//! again without the network. A blob sent from this Mac is read from its file here (`own.rs`), and
//! draws as that file did while it was being sent until its own decode is in. Views that draw them
//! observe this entity, so a picture shows as it comes.
// The typed API the views use; parts not yet drawn are still the API.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{App, AppContext, Context, Entity, Global, Image, ImageFormat, ImageSource, RenderImage};
use image::{AnimationDecoder, Frame, RgbaImage};
use lru::LruCache;

use crate::net::Net;

/// What's decoded, at most: about twenty-five pictures at chat size (each also has its texture).
const DECODED: usize = 48 << 20;
/// How lately a picture was drawn for it to be on screen still, and kept past `DECODED`.
const SHOWN: Duration = Duration::from_secs(1);
/// What's fetched and kept to decode again.
const FETCHED: usize = 16 << 20;
/// The size `get` decodes to, in pixels on its longest side: a chat picture (240 points tall, at
/// most 420 wide) on a Retina screen.
pub const DISPLAY: u32 = 720;

/// A decoded picture and when it was last drawn.
type Kept = (Shown, Instant);

#[derive(Clone)]
enum Shown {
    Render(Arc<RenderImage>, usize),
    /// An SVG: gpui draws it at the size it's drawn.
    Vector(Arc<Image>, usize),
}

impl Shown {
    fn cost(&self) -> usize {
        match self {
            Shown::Render(_, n) | Shown::Vector(_, n) => *n,
        }
    }

    fn source(&self) -> ImageSource {
        match self {
            Shown::Render(r, _) => ImageSource::Render(r.clone()),
            Shown::Vector(i, _) => ImageSource::Image(i.clone()),
        }
    }
}

/// Where a picture's bytes come from.
#[derive(Clone, Hash, PartialEq, Eq, Debug)]
enum From {
    Blob(String),
    File(PathBuf),
}

type Key = (From, u32);

pub struct Pictures {
    decoded: LruCache<Key, Kept>,
    decoded_bytes: usize,
    fetched: LruCache<From, Arc<Vec<u8>>>,
    fetched_bytes: usize,
    loading: HashSet<Key>,
    failed: HashSet<From>,
    /// Fetched again once after failing, as the desktop's query retries once.
    retried: HashSet<From>,
    /// Who waits on bytes being fetched.
    waiting: HashMap<From, Vec<(u32, Option<ImageFormat>)>>,
}

pub struct PicturesHandle(pub Entity<Pictures>);
impl Global for PicturesHandle {}

/// A picture's format by its type, when gpui draws it.
pub fn format_of(kind: &str, name: &str) -> Option<ImageFormat> {
    let ext = name.rsplit('.').next().unwrap_or_default().to_lowercase();
    Some(match (kind, ext.as_str()) {
        ("image/png", _) | (_, "png") => ImageFormat::Png,
        ("image/jpeg" | "image/jpg", _) | (_, "jpg" | "jpeg") => ImageFormat::Jpeg,
        ("image/webp", _) | (_, "webp") => ImageFormat::Webp,
        ("image/gif", _) | (_, "gif") => ImageFormat::Gif,
        ("image/svg+xml", _) | (_, "svg") => ImageFormat::Svg,
        ("image/bmp", _) | (_, "bmp") => ImageFormat::Bmp,
        ("image/tiff", _) | (_, "tif" | "tiff") => ImageFormat::Tiff,
        // ImageIO reads it; gpui has no name for it.
        ("image/heic" | "image/heif", _) | (_, "heic" | "heif") => ImageFormat::Jpeg,
        _ => return None,
    })
}

/// A picture's format by its first bytes: a cover's blob says no type.
fn sniff(b: &[u8]) -> Option<ImageFormat> {
    Some(match b {
        [0x89, b'P', b'N', b'G', ..] => ImageFormat::Png,
        [0xff, 0xd8, ..] => ImageFormat::Jpeg,
        [b'G', b'I', b'F', b'8', ..] => ImageFormat::Gif,
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => ImageFormat::Webp,
        [b'B', b'M', ..] => ImageFormat::Bmp,
        [b'I', b'I', 42, 0, ..] | [b'M', b'M', 0, 42, ..] => ImageFormat::Tiff,
        [b'<', ..] => ImageFormat::Svg,
        _ => return None,
    })
}

/// The decode size a drawn size asks for, rounded up to a step so near sizes share one.
fn bucket(px: u32) -> u32 {
    px.clamp(64, 4096).div_ceil(240) * 240
}

/// A still picture decoded by ImageIO straight at `max` pixels on its longest side (JPEG's own
/// scaled decode; HEIC, TIFF, WebP and PNG too), upright, as the BGRA gpui's atlas takes: never
/// the photo's full size in memory.
fn thumbnail(bytes: &[u8], max: u32) -> Option<RgbaImage> {
    use objc2_core_foundation::{CFBoolean, CFData, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{CGBitmapContextCreate, CGImageByteOrderInfo, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo};
    use objc2_image_io::{CGImageSource, kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceThumbnailMaxPixelSize};
    let data = CFData::from_bytes(bytes);
    let source = unsafe { CGImageSource::with_data(&data, None) }?;
    let size = CFNumber::new_i32(max as i32);
    let yes = CFBoolean::new(true);
    let keys: [&CFString; 3] = unsafe { [kCGImageSourceThumbnailMaxPixelSize, kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform] };
    let values: [&CFType; 3] = [size.as_ref(), yes.as_ref(), yes.as_ref()];
    let options: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(&keys, &values);
    let image = unsafe { source.thumbnail_at_index(0, Some(options.as_opaque())) }?;
    let (w, h) = (CGImage::width(Some(&image)), CGImage::height(Some(&image)));
    if w == 0 || h == 0 {
        return None;
    }
    let mut buf = vec![0u8; w * h * 4];
    let space = CGColorSpace::new_device_rgb()?;
    let info = CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0;
    let cx = unsafe { CGBitmapContextCreate(buf.as_mut_ptr().cast(), w, h, 8, w * 4, Some(&space), info) }?;
    CGContext::draw_image(Some(&cx), CGRect::new(CGPoint::new(0., 0.), CGSize::new(w as f64, h as f64)), Some(&image));
    drop(cx);
    // Straight alpha, as gpui's own decode gives it.
    for p in buf.chunks_exact_mut(4) {
        let a = p[3] as u32;
        if a != 0 && a != 255 {
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    RgbaImage::from_raw(w as u32, h as u32, buf)
}

/// RGBA to the BGRA gpui's atlas takes, scaled to fit in `max` pixels.
fn fit(img: RgbaImage, max: u32) -> RgbaImage {
    let (w, h) = img.dimensions();
    let mut img = if w.max(h) > max {
        let s = max as f64 / w.max(h) as f64;
        image::imageops::resize(&img, ((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1), image::imageops::FilterType::Triangle)
    } else {
        img
    };
    for p in img.pixels_mut() {
        p.0.swap(0, 2);
    }
    img
}

/// An animated WebP's or APNG's frames, fitted to `max`; none for a still one.
fn animated(bytes: &[u8], format: ImageFormat, max: u32) -> Option<Vec<Frame>> {
    use image::AnimationDecoder;
    let frames: Vec<image::Frame> = match format {
        ImageFormat::Webp => {
            let d = image::codecs::webp::WebPDecoder::new(std::io::Cursor::new(bytes)).ok()?;
            if !d.has_animation() {
                return None;
            }
            d.into_frames().filter_map(Result::ok).collect()
        }
        ImageFormat::Png => {
            let d = image::codecs::png::PngDecoder::new(std::io::Cursor::new(bytes)).ok()?;
            if !d.is_apng().ok()? {
                return None;
            }
            d.apng().ok()?.into_frames().filter_map(Result::ok).collect()
        }
        _ => return None,
    };
    let frames: Vec<Frame> = frames
        .into_iter()
        .map(|f| {
            let delay = f.delay();
            Frame::from_parts(fit(f.into_buffer(), max), 0, 0, delay)
        })
        .collect();
    (frames.len() > 1).then_some(frames)
}

/// Decodes at `max` pixels on the longest side; none when it isn't a picture this reads.
fn decode(bytes: &[u8], hint: Option<ImageFormat>, max: u32) -> Option<Shown> {
    // A format this doesn't sniff (HEIC) is ImageIO's to read.
    let format = sniff(bytes).or(hint).unwrap_or(ImageFormat::Jpeg);
    if format == ImageFormat::Svg {
        return Some(Shown::Vector(Arc::new(Image::from_bytes(ImageFormat::Svg, bytes.to_vec())), bytes.len()));
    }
    // An animated WebP or PNG (APNG) plays, as a page's `img` plays it: its frames, each its time.
    if let Some(frames) = animated(bytes, format, max) {
        let cost = frames.iter().map(|f| f.buffer().as_raw().len()).sum();
        return Some(Shown::Render(Arc::new(RenderImage::new(frames)), cost));
    }
    let frames: Vec<Frame> = if format != ImageFormat::Gif {
        vec![Frame::new(thumbnail(bytes, max)?)]
    } else if format == ImageFormat::Gif {
        let d = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(bytes)).ok()?;
        d.into_frames()
            .filter_map(Result::ok)
            .map(|f| {
                let delay = f.delay();
                Frame::from_parts(fit(f.into_buffer(), max), 0, 0, delay)
            })
            .collect()
    } else {
        let f = match format {
            ImageFormat::Png => image::ImageFormat::Png,
            ImageFormat::Jpeg => image::ImageFormat::Jpeg,
            ImageFormat::Webp => image::ImageFormat::WebP,
            ImageFormat::Bmp => image::ImageFormat::Bmp,
            ImageFormat::Tiff => image::ImageFormat::Tiff,
            _ => return None,
        };
        let img = image::load_from_memory_with_format(bytes, f).ok()?;
        vec![Frame::new(fit(img.into_rgba8(), max))]
    };
    if frames.is_empty() {
        return None;
    }
    let cost = frames.iter().map(|f| f.buffer().as_raw().len()).sum();
    Some(Shown::Render(Arc::new(RenderImage::new(frames)), cost))
}

/// A still or animated picture decoded at `max` pixels on its longest side, for a picture drawn
/// once and let go by whoever holds it (`App::drop_image`), such as a camera's frame.
pub fn still(bytes: &[u8], max: u32) -> Option<Arc<RenderImage>> {
    match decode(bytes, None, max)? {
        Shown::Render(r, _) => Some(r),
        Shown::Vector(..) => None,
    }
}

impl Pictures {
    pub fn init(cx: &mut App) {
        let e = cx.new(|_| Pictures {
            decoded: LruCache::unbounded(),
            decoded_bytes: 0,
            fetched: LruCache::new(NonZeroUsize::new(4096).expect("size")),
            fetched_bytes: 0,
            loading: HashSet::new(),
            failed: HashSet::new(),
            retried: HashSet::new(),
            waiting: HashMap::new(),
        });
        cx.set_global(PicturesHandle(e));
    }

    pub fn entity(cx: &App) -> Entity<Pictures> {
        cx.global::<PicturesHandle>().0.clone()
    }

    /// Blob `hash` as a picture at chat size, once it's in; asked for the first time, it's fetched.
    pub fn get(hash: &str, format: ImageFormat, cx: &mut App) -> Option<ImageSource> {
        Self::sized(hash, Some(format), DISPLAY, cx)
    }

    /// Blob `hash` as a picture decoded to `px` pixels on its longest side (its drawn size times the
    /// screen's scale).
    pub fn sized(hash: &str, format: Option<ImageFormat>, px: u32, cx: &mut App) -> Option<ImageSource> {
        Self::want(From::Blob(hash.to_string()), format, px, cx)
    }

    /// A file on this Mac as a picture (a chosen file's chip), decoded to `px`.
    pub fn local(path: PathBuf, px: u32, cx: &mut App) -> Option<ImageSource> {
        Self::want(From::File(path), None, px, cx)
    }

    /// How many pictures couldn't be had: a row drawing one as its name changes height.
    pub fn failures(cx: &App) -> usize {
        Self::entity(cx).read(cx).failed.len()
    }

    /// A blob's picture drawn anew (scrolled back to, or its page opened again): one that couldn't
    /// be had is fetched again, as the desktop's query refetches on mount.
    pub fn mounted(hash: &str, cx: &mut App) {
        let from = From::Blob(hash.to_string());
        Self::entity(cx).update(cx, |p, _| {
            p.failed.remove(&from);
            p.retried.remove(&from);
        });
    }

    /// Whether a blob's picture couldn't be had: a file card shows instead.
    pub fn failed(hash: &str, cx: &App) -> bool {
        Self::entity(cx).read(cx).failed.contains(&From::Blob(hash.to_string()))
    }

    fn want(from: From, hint: Option<ImageFormat>, px: u32, cx: &mut App) -> Option<ImageSource> {
        let key = (from.clone(), bucket(px));
        let this = Self::entity(cx);
        // A blob sent from here draws as its kept file did while it was sent, until its own is in.
        let sent = match &from {
            From::Blob(hash) => crate::own::sent_as(hash).map(|id| (From::File(crate::outbox::file_path(&id)), key.1)),
            From::File(_) => None,
        };
        let (hit, start) = this.update(cx, |p, _| {
            if let Some((s, drawn)) = p.decoded.get_mut(&key) {
                *drawn = Instant::now();
                return (Some(s.source()), false);
            }
            let was = sent.and_then(|k| p.decoded.get_mut(&k)).map(|(s, drawn)| {
                *drawn = Instant::now();
                s.source()
            });
            (was, !p.loading.contains(&key) && !p.failed.contains(&from))
        });
        if start {
            this.update(cx, |p, cx| p.load(key, hint, cx));
        }
        hit
    }

    fn load(&mut self, key: Key, hint: Option<ImageFormat>, cx: &mut Context<Self>) {
        self.loading.insert(key.clone());
        let (from, px) = key;
        if let Some(bytes) = self.fetched.get(&from).cloned() {
            self.decode_later(from, bytes, hint, px, cx);
            return;
        }
        let waiters = self.waiting.entry(from.clone()).or_default();
        waiters.push((px, hint));
        if waiters.len() > 1 {
            return;
        }
        let job: gpui::Task<Option<Vec<u8>>> = match &from {
            // One sent from here is read from its link on this Mac.
            From::Blob(hash) => match crate::own::of_blob(hash) {
                // Gone meanwhile, it's fetched on the retry.
                Some(path) => cx.background_executor().spawn(async move { std::fs::read(path).ok() }),
                None => {
                    let job = cx.global::<Net>().fetch(format!("/blobs/{hash}"));
                    cx.background_executor().spawn(async move { job.await.ok().flatten() })
                }
            },
            From::File(path) => {
                let path = path.clone();
                cx.background_executor().spawn(async move {
                    // A chosen file's bytes may still be on their way beside the outbox.
                    if let Some(id) = path.file_name().map(|n| n.to_string_lossy().to_string()) {
                        crate::files::kept(&id).await;
                    }
                    std::fs::read(path).ok()
                })
            }
        };
        cx.spawn(async move |this, cx| {
            let bytes = job.await;
            this.update(cx, |p, cx| {
                let waiters = p.waiting.remove(&from).unwrap_or_default();
                match bytes {
                    Some(b) => {
                        p.retried.remove(&from);
                        let b = Arc::new(b);
                        p.keep_fetched(from.clone(), b.clone());
                        for (px, hint) in waiters {
                            p.decode_later(from.clone(), b.clone(), hint, px, cx);
                        }
                    }
                    // Once more a second on, then it's failed.
                    None if p.retried.insert(from.clone()) => {
                        cx.spawn(async move |this, cx| {
                            cx.background_executor().timer(std::time::Duration::from_secs(1)).await;
                            this.update(cx, |p, cx| {
                                for (px, hint) in waiters {
                                    p.load((from.clone(), px), hint, cx);
                                }
                            })
                            .ok();
                        })
                        .detach();
                    }
                    None => {
                        for (px, _) in waiters {
                            p.loading.remove(&(from.clone(), px));
                        }
                        p.failed.insert(from);
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    fn keep_fetched(&mut self, from: From, bytes: Arc<Vec<u8>>) {
        self.fetched_bytes += bytes.len();
        if let Some(old) = self.fetched.put(from, bytes) {
            self.fetched_bytes -= old.len();
        }
        while self.fetched_bytes > FETCHED {
            let Some((_, b)) = self.fetched.pop_lru() else { break };
            self.fetched_bytes -= b.len();
        }
    }

    fn decode_later(&mut self, from: From, bytes: Arc<Vec<u8>>, hint: Option<ImageFormat>, px: u32, cx: &mut Context<Self>) {
        let job = cx.background_executor().spawn(async move { decode(&bytes, hint, px) });
        cx.spawn(async move |this, cx| {
            let shown = job.await;
            this.update(cx, |p, cx| {
                let key = (from.clone(), px);
                p.loading.remove(&key);
                match shown {
                    Some(s) => {
                        p.decoded_bytes += s.cost();
                        if let Some((old, _)) = p.decoded.put(key, (s, Instant::now())) {
                            p.decoded_bytes -= old.cost();
                            p.free(old, cx);
                        }
                        while p.decoded_bytes > DECODED && p.decoded.len() > 1 {
                            if p.decoded.peek_lru().is_some_and(|(_, (_, drawn))| drawn.elapsed() < SHOWN) {
                                break;
                            }
                            let Some((_, (old, _))) = p.decoded.pop_lru() else { break };
                            p.decoded_bytes -= old.cost();
                            p.free(old, cx);
                        }
                    }
                    None => {
                        p.failed.insert(from);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Takes a picture's texture out of every window's atlas.
    fn free(&self, s: Shown, cx: &mut Context<Self>) {
        if let Shown::Render(r, _) = s {
            cx.drop_image(r, None);
        }
    }
}
