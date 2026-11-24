//! Color and tone adjustments with Core Image, which runs them on the graphics card, and hiding
//! part of an image by pixelating or blurring it.

use std::sync::OnceLock;

use image::{RgbaImage, imageops};
use objc2::{
    Message,
    rc::{Retained, autoreleasepool},
    runtime::AnyObject,
};
use objc2_core_foundation::CGRect;
use objc2_core_image::{
    CIContext, CIImage, CIVector, kCIInputContrastKey, kCIInputEVKey, kCIInputRadiusKey,
    kCIInputSaturationKey, kCIInputScaleKey, kCIInputSharpnessKey,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::bitmap;

/// Color and tone changes. Every field is 0 when unchanged.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Adjustments {
    /// Brightness, in stops of exposure: from -3 (darker) to 3 (brighter).
    pub exposure: f32,
    /// From -1 (flatter) to 1 (punchier).
    pub contrast: f32,
    /// From -1 (black and white) to 1 (more vivid).
    pub saturation: f32,
    /// From -1 (cooler, bluer) to 1 (warmer, more orange).
    pub warmth: f32,
    /// From -1 (greener) to 1 (more magenta).
    pub tint: f32,
    /// From 0 to 1: how much detail to bring back in bright areas.
    pub highlights: f32,
    /// From 0 to 1: how much to lighten dark areas.
    pub shadows: f32,
    /// From 0 to 1: how much to sharpen edges.
    pub sharpness: f32,
}

impl Adjustments {
    pub fn is_unchanged(&self) -> bool {
        *self == Self::default()
    }

    /// Every field brought into its range.
    pub fn clamped(self) -> Self {
        Self {
            exposure: self.exposure.clamp(-3., 3.),
            contrast: self.contrast.clamp(-1., 1.),
            saturation: self.saturation.clamp(-1., 1.),
            warmth: self.warmth.clamp(-1., 1.),
            tint: self.tint.clamp(-1., 1.),
            highlights: self.highlights.clamp(0., 1.),
            shadows: self.shadows.clamp(0., 1.),
            sharpness: self.sharpness.clamp(0., 1.),
        }
    }
}

/// How `obscure` hides a region.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Obscure {
    /// Large blocks of color.
    Pixelate,
    /// A heavy blur.
    Blur,
}

/// `image` with `adjustments` applied. Safe to call from any thread.
pub fn apply(image: &RgbaImage, adjustments: &Adjustments) -> Result<RgbaImage, String> {
    let adjustments = adjustments.clamped();
    if adjustments.is_unchanged() {
        return Ok(image.clone());
    }
    let Adjustments {
        exposure,
        contrast,
        saturation,
        warmth,
        tint,
        highlights,
        shadows,
        sharpness,
    } = adjustments;
    autoreleasepool(|_| {
        let input = unsafe { CIImage::imageWithCGImage(&bitmap::to_cg_image(image)) };
        let extent = unsafe { input.extent() };
        // Clamped, so filters that look at neighboring pixels, like sharpening, see the edge
        // pixels repeated rather than transparency.
        let mut output = unsafe { input.imageByClampingToExtent() };
        if exposure != 0. {
            output = filter(
                &output,
                "CIExposureAdjust",
                &[(key(unsafe { kCIInputEVKey }), number(exposure))],
            );
        }
        if contrast != 0. || saturation != 0. {
            output = filter(
                &output,
                "CIColorControls",
                &[
                    (
                        key(unsafe { kCIInputContrastKey }),
                        number(1. + contrast * 0.5),
                    ),
                    (
                        key(unsafe { kCIInputSaturationKey }),
                        number(1. + saturation),
                    ),
                ],
            );
        }
        if warmth != 0. || tint != 0. {
            // The light the picture is taken to be lit by. Saying it was bluer than it is makes
            // the picture warmer, the way a camera's white balance does.
            let lit_by = unsafe {
                CIVector::vectorWithX_Y(6500. + f64::from(warmth) * 3000., f64::from(tint) * 60.)
            };
            let neutral = unsafe { CIVector::vectorWithX_Y(6500., 0.) };
            output = filter(
                &output,
                "CITemperatureAndTint",
                &[
                    (
                        NSString::from_str("inputNeutral"),
                        Retained::into_super(Retained::into_super(lit_by)),
                    ),
                    (
                        NSString::from_str("inputTargetNeutral"),
                        Retained::into_super(Retained::into_super(neutral)),
                    ),
                ],
            );
        }
        if highlights != 0. || shadows != 0. {
            output = filter(
                &output,
                "CIHighlightShadowAdjust",
                &[
                    (
                        NSString::from_str("inputHighlightAmount"),
                        number(1. - highlights),
                    ),
                    (NSString::from_str("inputShadowAmount"), number(shadows)),
                ],
            );
        }
        if sharpness != 0. {
            output = filter(
                &output,
                "CISharpenLuminance",
                &[
                    (
                        key(unsafe { kCIInputSharpnessKey }),
                        number(sharpness * 1.5),
                    ),
                    (key(unsafe { kCIInputRadiusKey }), number(2.)),
                ],
            );
        }
        render(&output, extent)
    })
}

/// Makes a region unreadable, strongly enough that text in it can't be read back: the blocks or
/// blur grow with the region. Pixels outside it are untouched. Safe to call from any thread.
pub fn obscure(
    image: &mut RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    how: Obscure,
) -> Result<(), String> {
    let x = x.min(image.width());
    let y = y.min(image.height());
    let width = width.min(image.width() - x);
    let height = height.min(image.height() - y);
    if width == 0 || height == 0 {
        return Ok(());
    }
    let region = imageops::crop_imm(image, x, y, width, height).to_image();
    let longest = f64::from(width.max(height));
    let hidden = autoreleasepool(|_| {
        let input = unsafe { CIImage::imageWithCGImage(&bitmap::to_cg_image(&region)) };
        let extent = unsafe { input.extent() };
        let clamped = unsafe { input.imageByClampingToExtent() };
        let output = match how {
            Obscure::Pixelate => filter(
                &clamped,
                "CIPixellate",
                &[(
                    key(unsafe { kCIInputScaleKey }),
                    number((longest / 12.).max(12.) as f32),
                )],
            ),
            Obscure::Blur => filter(
                &clamped,
                "CIGaussianBlur",
                &[(
                    key(unsafe { kCIInputRadiusKey }),
                    number((longest / 10.).max(12.) as f32),
                )],
            ),
        };
        render(&output, extent)
    })?;
    imageops::replace(image, &hidden, i64::from(x), i64::from(y));
    Ok(())
}

/// The process's one Core Image context. Making one is slow, and it's safe to share.
fn context() -> &'static CIContext {
    static CONTEXT: OnceLock<Retained<CIContext>> = OnceLock::new();
    CONTEXT.get_or_init(|| unsafe { CIContext::contextWithOptions(None) })
}

/// Draws `image`'s pixels inside `extent`.
fn render(image: &CIImage, extent: CGRect) -> Result<RgbaImage, String> {
    let drawn = unsafe { context().createCGImage_fromRect(image, extent) }
        .ok_or("Core Image couldn't draw the image")?;
    Ok(bitmap::from_cg_image(&drawn))
}

/// `image` through the Core Image filter `name`, with `parameters` as its inputs.
fn filter(
    image: &CIImage,
    name: &str,
    parameters: &[(Retained<NSString>, Retained<AnyObject>)],
) -> Retained<CIImage> {
    let keys: Vec<&NSString> = parameters.iter().map(|(key, _)| &**key).collect();
    let values: Vec<&AnyObject> = parameters.iter().map(|(_, value)| &**value).collect();
    let parameters = NSDictionary::<NSString, AnyObject>::from_slices(&keys, &values);
    unsafe {
        image.imageByApplyingFilter_withInputParameters(&NSString::from_str(name), &parameters)
    }
}

fn key(key: &NSString) -> Retained<NSString> {
    key.retain()
}

fn number(value: f32) -> Retained<AnyObject> {
    Retained::into_super(Retained::into_super(Retained::into_super(
        NSNumber::new_f64(f64::from(value)),
    )))
}
