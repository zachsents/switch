//! Reading and writing image files with ImageIO, which reads every format macOS knows (JPEG,
//! PNG, HEIC, AVIF, WebP, GIF, TIFF, BMP, camera raw and more) and converts their colors to sRGB.
//! It writes most of them too; WebP is written with libwebp, since ImageIO only reads it.

use std::path::Path;

use image::{DynamicImage, RgbImage, RgbaImage, metadata::Orientation};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFMutableData, CFNumber, CFRetained, CFString, CFType, CFURL,
};
use objc2_image_io::{
    CGImageDestination, CGImageMetadata, CGImageSource, CGMutableImageMetadata,
    kCGImageDestinationLossyCompressionQuality, kCGImagePropertyGPSDictionary,
    kCGImagePropertyOrientation, kCGImagePropertyTIFFDictionary, kCGImagePropertyTIFFMake,
    kCGImagePropertyTIFFModel, kCGImagePropertyTIFFOrientation,
    kCGImageSourceCreateThumbnailFromImageIfAbsent, kCGImageSourceCreateThumbnailWithTransform,
    kCGImageSourceThumbnailMaxPixelSize,
};

use crate::bitmap;

/// A format images can be written in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Format {
    Jpeg,
    Png,
    Heic,
    Avif,
    Webp,
    Gif,
    Tiff,
    Bmp,
}

impl Format {
    pub const ALL: [Self; 8] = [
        Self::Jpeg,
        Self::Png,
        Self::Heic,
        Self::Avif,
        Self::Webp,
        Self::Gif,
        Self::Tiff,
        Self::Bmp,
    ];

    /// The format of files of a uniform type, like "public.jpeg". HEIF files are written as
    /// HEIC, the HEIF that macOS writes.
    pub fn from_type_identifier(identifier: &str) -> Option<Self> {
        match identifier {
            "public.heif" => Some(Self::Heic),
            identifier => Self::ALL
                .into_iter()
                .find(|format| format.type_identifier() == identifier),
        }
    }

    pub fn type_identifier(self) -> &'static str {
        match self {
            Self::Jpeg => "public.jpeg",
            Self::Png => "public.png",
            Self::Heic => "public.heic",
            Self::Avif => "public.avif",
            Self::Webp => "org.webmproject.webp",
            Self::Gif => "com.compuserve.gif",
            Self::Tiff => "public.tiff",
            Self::Bmp => "com.microsoft.bmp",
        }
    }

    /// How people know it, like "JPEG".
    pub fn name(self) -> &'static str {
        match self {
            Self::Jpeg => "JPEG",
            Self::Png => "PNG",
            Self::Heic => "HEIC",
            Self::Avif => "AVIF",
            Self::Webp => "WebP",
            Self::Gif => "GIF",
            Self::Tiff => "TIFF",
            Self::Bmp => "BMP",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Heic => "heic",
            Self::Avif => "avif",
            Self::Webp => "webp",
            Self::Gif => "gif",
            Self::Tiff => "tiff",
            Self::Bmp => "bmp",
        }
    }

    /// Whether it trades detail for size, so a quality applies.
    pub fn is_lossy(self) -> bool {
        matches!(self, Self::Jpeg | Self::Heic | Self::Avif | Self::Webp)
    }

    /// Whether it keeps transparency. JPEGs are flattened onto white.
    pub fn keeps_transparency(self) -> bool {
        self != Self::Jpeg
    }

    /// Whether this Mac can write it. AVIF needs macOS 13 or later.
    pub fn can_write(self) -> bool {
        self == Self::Webp || writable_type_identifiers().contains(&self.type_identifier())
    }
}

/// The uniform types ImageIO can write here.
fn writable_type_identifiers() -> Vec<&'static str> {
    let writable: CFRetained<CFArray<CFString>> =
        unsafe { CFRetained::cast_unchecked(CGImageDestination::type_identifiers()) };
    let writable: Vec<String> = writable
        .iter()
        .map(|identifier| identifier.to_string())
        .collect();
    Format::ALL
        .into_iter()
        .map(Format::type_identifier)
        .filter(|identifier| writable.iter().any(|writable| writable == identifier))
        .collect()
}

/// An image file's pixels, upright, and what it is.
pub struct Decoded {
    pub image: RgbaImage,
    /// Its format, when it can be written back. Some formats, like camera raw, only read.
    pub format: Option<Format>,
    /// How people know its format, like "JPEG" or "DNG".
    pub kind: String,
    /// Whether it records where it was taken.
    pub location: bool,
    /// Whether it records the camera that took it.
    pub camera: bool,
}

/// Reads an image file, turned upright the way its orientation tag says and converted to sRGB.
/// Animated images give their first frame.
pub fn decode(path: &Path) -> Result<Decoded, String> {
    let source = open(path)?;
    let image = unsafe { source.image_at_index(0, None) }
        .ok_or_else(|| format!("{} isn't an image macOS can read", file_name(path)))?;
    let properties = Properties::of(&source);
    let mut upright = DynamicImage::ImageRgba8(bitmap::from_cg_image(&image));
    upright.apply_orientation(properties.orientation());
    let type_identifier = unsafe { source.r#type() }
        .map(|identifier| identifier.to_string())
        .unwrap_or_default();
    let format = Format::from_type_identifier(&type_identifier);
    Ok(Decoded {
        image: upright.into_rgba8(),
        format,
        kind: format.map_or_else(|| kind_from_extension(path), |format| format.name().into()),
        location: properties.has(unsafe { kCGImagePropertyGPSDictionary }),
        camera: properties.has_camera(),
    })
}

/// A small upright copy of an image file, at most `longest` pixels on its longer side. Uses the
/// preview a photo carries when it has one big enough, so it's quick.
pub fn thumbnail(path: &Path, longest: u32) -> Result<RgbaImage, String> {
    let source = open(path)?;
    let keys: [&CFString; 3] = unsafe {
        [
            kCGImageSourceCreateThumbnailFromImageIfAbsent,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceThumbnailMaxPixelSize,
        ]
    };
    let longest = CFNumber::new_i64(i64::from(longest));
    let values: [&CFType; 3] = [CFBoolean::new(true), CFBoolean::new(true), &longest];
    let options = CFDictionary::<CFString, CFType>::from_slices(&keys, &values);
    let image = unsafe { source.thumbnail_at_index(0, Some(options.as_ref())) }
        .ok_or_else(|| format!("{} isn't an image macOS can read", file_name(path)))?;
    Ok(bitmap::from_cg_image(&image))
}

/// Encodes `image` as a new file's contents, with no metadata at all, so no location or camera
/// details. `quality` runs from 0 (smallest) to 1 (best) and only matters for lossy formats.
pub fn encode(image: &RgbaImage, format: Format, quality: f32) -> Result<Vec<u8>, String> {
    match format {
        Format::Webp => encode_webp(image, quality),
        format => encode_with_image_io(image, format, quality, None),
    }
}

/// Encodes `image` to replace the file at `original`, keeping its metadata, like the date and
/// camera. The orientation tag is reset, since the pixels are written upright. WebP files keep
/// none, since they're written with libwebp.
pub fn encode_keeping_metadata(
    image: &RgbaImage,
    format: Format,
    quality: f32,
    original: &Path,
) -> Result<Vec<u8>, String> {
    if format == Format::Webp {
        return encode_webp(image, quality);
    }
    let source = open(original)?;
    let metadata = unsafe { source.metadata_at_index(0, None) }
        .and_then(|metadata| unsafe { CGMutableImageMetadata::new_copy(&metadata) });
    if let Some(metadata) = &metadata {
        let upright = CFNumber::new_i32(1);
        unsafe {
            metadata.set_value_matching_image_property(
                kCGImagePropertyTIFFDictionary,
                kCGImagePropertyTIFFOrientation,
                &upright,
            );
        }
    }
    encode_with_image_io(image, format, quality, metadata.as_deref().map(|m| &**m))
}

fn encode_with_image_io(
    image: &RgbaImage,
    format: Format,
    quality: f32,
    metadata: Option<&CGImageMetadata>,
) -> Result<Vec<u8>, String> {
    let cannot = || format!("This Mac can't write {}", format.name());
    let data = CFMutableData::new(None, 0).ok_or_else(cannot)?;
    let type_identifier = CFString::from_static_str(format.type_identifier());
    let destination = unsafe { CGImageDestination::with_data(&data, &type_identifier, 1, None) }
        .ok_or_else(cannot)?;
    let keys: [&CFString; 2] = unsafe {
        [
            kCGImageDestinationLossyCompressionQuality,
            kCGImagePropertyOrientation,
        ]
    };
    let quality = CFNumber::new_f64(f64::from(quality.clamp(0., 1.)));
    let upright = CFNumber::new_i32(1);
    let values: [&CFType; 2] = [&quality, &upright];
    let options = CFDictionary::<CFString, CFType>::from_slices(&keys, &values);
    let pixels = if format.keeps_transparency() {
        bitmap::to_cg_image(image)
    } else {
        bitmap::to_cg_image(&flatten_onto_white(image))
    };
    unsafe { destination.add_image_and_metadata(&pixels, metadata, Some(options.as_ref())) };
    if !unsafe { destination.finalize() } {
        return Err(format!("Couldn't write the {}", format.name()));
    }
    Ok(data.to_vec())
}

fn encode_webp(image: &RgbaImage, quality: f32) -> Result<Vec<u8>, String> {
    let encoder = webp::Encoder::from_rgba(image.as_raw(), image.width(), image.height());
    let encoded = encoder
        .encode_simple(false, quality.clamp(0., 1.) * 100.)
        .map_err(|error| format!("Couldn't write the WebP: {error:?}"))?;
    Ok(encoded.to_vec())
}

/// The image composited onto white, without alpha. Its RGBA form, opaque, for CoreGraphics.
fn flatten_onto_white(image: &RgbaImage) -> RgbaImage {
    let flat = RgbImage::from_fn(image.width(), image.height(), |x, y| {
        let [r, g, b, a] = image.get_pixel(x, y).0;
        let over_white = |channel: u8| {
            let alpha = u16::from(a);
            ((u16::from(channel) * alpha + 255 * (255 - alpha)) / 255) as u8
        };
        image::Rgb([over_white(r), over_white(g), over_white(b)])
    });
    DynamicImage::ImageRgb8(flat).into_rgba8()
}

fn open(path: &Path) -> Result<CFRetained<CGImageSource>, String> {
    let url =
        CFURL::from_file_path(path).ok_or_else(|| format!("{} isn't a file", path.display()))?;
    unsafe { CGImageSource::with_url(&url, None) }
        .ok_or_else(|| format!("Couldn't open {}", file_name(path)))
}

fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// "DNG" for "photo.dng", for formats this crate can't write.
fn kind_from_extension(path: &Path) -> String {
    path.extension()
        .map(|extension| extension.to_string_lossy().to_uppercase())
        .unwrap_or_else(|| "Image".into())
}

/// An image's properties, as ImageIO reads them.
struct Properties(Option<CFRetained<CFDictionary<CFString, CFType>>>);

impl Properties {
    fn of(source: &CGImageSource) -> Self {
        Self(
            unsafe { source.properties_at_index(0, None) }
                .map(|properties| unsafe { CFRetained::cast_unchecked(properties) }),
        )
    }

    fn get(&self, key: &CFString) -> Option<CFRetained<CFType>> {
        self.0.as_ref()?.get(key)
    }

    fn has(&self, key: &CFString) -> bool {
        self.get(key).is_some()
    }

    fn orientation(&self) -> Orientation {
        self.get(unsafe { kCGImagePropertyOrientation })
            .and_then(|value| value.downcast::<CFNumber>().ok())
            .and_then(|number| number.as_i64())
            .and_then(|number| Orientation::from_exif(u8::try_from(number).ok()?))
            .unwrap_or(Orientation::NoTransforms)
    }

    fn has_camera(&self) -> bool {
        let Some(tiff) = self
            .get(unsafe { kCGImagePropertyTIFFDictionary })
            .and_then(|value| value.downcast::<CFDictionary>().ok())
        else {
            return false;
        };
        let tiff: CFRetained<CFDictionary<CFString, CFType>> =
            unsafe { CFRetained::cast_unchecked(tiff) };
        unsafe { [kCGImagePropertyTIFFMake, kCGImagePropertyTIFFModel] }
            .into_iter()
            .any(|key| tiff.contains_key(key))
    }
}
