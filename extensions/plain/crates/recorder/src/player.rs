//! Playing a recording inside the window. AVFoundation plays the sound and keeps the time; the
//! window draws the frames it hands over.

use std::{cell::Cell, path::Path, ptr, slice, sync::Mutex};

use block2::RcBlock;
use futures::channel::oneshot;

use imaging::RgbaImage;
use objc2::{AnyThread, rc::Retained, runtime::AnyObject};
use objc2_av_foundation::{
    AVAssetImageGenerator, AVPlayer, AVPlayerItem, AVPlayerItemStatus, AVPlayerItemVideoOutput,
};
use objc2_core_foundation::{CFString, CGSize};
use objc2_core_graphics::CGImage;
use objc2_core_media::{CMTime, CMTimeFlags};
use objc2_core_video::{
    CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight,
    CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferUnlockBaseAddress, kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_32BGRA,
};
use objc2_foundation::{MainThreadMarker, NSDictionary, NSError, NSNumber, NSString, NSURL};

pub struct Player {
    player: Retained<AVPlayer>,
    item: Retained<AVPlayerItem>,
    output: Retained<AVPlayerItemVideoOutput>,
    /// Whether it's been sought since the video loaded. Until then there's no frame to show
    /// while paused.
    primed: Cell<bool>,
    /// Makes stills of the video, for showing it while paused: the playing output only hands
    /// over frames as they play.
    stills: Retained<AVAssetImageGenerator>,
    /// In seconds.
    duration: f64,
}

impl Player {
    /// Opens `video`, `duration` seconds long, paused at the start. Must be on the main thread.
    pub fn open(video: &Path, duration: f64) -> Option<Self> {
        let main_thread = MainThreadMarker::new()?;
        let url = NSURL::fileURLWithPath(&NSString::from_str(&video.to_string_lossy()));
        let item = unsafe { AVPlayerItem::playerItemWithURL(&url, main_thread) };
        // SAFETY: CFString and NSString are toll-free bridged.
        let format_key: &NSString = unsafe {
            &*ptr::from_ref::<CFString>(kCVPixelBufferPixelFormatTypeKey).cast::<NSString>()
        };
        let bgra = NSNumber::new_u32(kCVPixelFormatType_32BGRA);
        let attributes =
            NSDictionary::<NSString, AnyObject>::from_slices(&[format_key], &[bgra.as_ref()]);
        let output = unsafe {
            AVPlayerItemVideoOutput::initWithPixelBufferAttributes(
                AVPlayerItemVideoOutput::alloc(),
                Some(&attributes),
            )
        };
        unsafe { item.addOutput(&output) };
        let stills = unsafe { AVAssetImageGenerator::assetImageGeneratorWithAsset(&item.asset()) };
        unsafe {
            stills.setAppliesPreferredTrackTransform(true);
            stills.setMaximumSize(CGSize {
                width: 1280.,
                height: 1280.,
            });
            stills.setRequestedTimeToleranceBefore(moment(0.));
            stills.setRequestedTimeToleranceAfter(moment(0.));
        }
        let player = unsafe { AVPlayer::playerWithPlayerItem(Some(&item), main_thread) };
        Some(Self {
            player,
            item,
            output,
            primed: Cell::new(false),
            stills,
            duration,
        })
    }

    pub fn is_playing(&self) -> bool {
        let rate = unsafe { self.player.rate() };
        rate != 0.
    }

    /// Plays from where it is, or from the start if it had played to the end.
    pub fn play(&self) {
        if self.time() >= self.duration - 0.1 {
            self.seek(0.);
        }
        unsafe { self.player.play() };
    }

    pub fn pause(&self) {
        unsafe { self.player.pause() };
    }

    /// Where it is, in seconds.
    pub fn time(&self) -> f64 {
        let time = unsafe { self.player.currentTime() };
        if time.flags.contains(CMTimeFlags::Valid) && time.timescale > 0 {
            time.value as f64 / f64::from(time.timescale)
        } else {
            0.
        }
    }

    /// Moves to `seconds` in, exactly, so a click on a line lands on its first word.
    pub fn seek(&self, seconds: f64) {
        let at = moment(seconds.clamp(0., self.duration));
        unsafe {
            self.player
                .seekToTime_toleranceBefore_toleranceAfter(at, moment(0.), moment(0.))
        };
    }

    /// A still of the video `seconds` in, as RGBA, for showing while paused. It arrives from
    /// another thread, or None if the video can't give one.
    pub fn still(&self, seconds: f64) -> oneshot::Receiver<Option<RgbaImage>> {
        let (sender, receiver) = oneshot::channel();
        let sender = Mutex::new(Some(sender));
        let handler = RcBlock::new(move |image: *mut CGImage, _: CMTime, _: *mut NSError| {
            let still = unsafe { image.as_ref() }.map(imaging::from_cg_image);
            if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
                sender.send(still).ok();
            }
        });
        unsafe {
            self.stills
                .generateCGImageAsynchronouslyForTime_completionHandler(moment(seconds), &handler)
        };
        receiver
    }

    /// The frame for now if it's changed since the last one, as BGRA pixels (what GPUI draws)
    /// with the longer side at most about `longest`.
    pub fn frame(&self, longest: usize) -> Option<RgbaImage> {
        // Seeking once the video has loaded makes a frame available while paused.
        if !self.primed.get() && unsafe { self.item.status() } == AVPlayerItemStatus::ReadyToPlay {
            self.primed.set(true);
            self.seek(self.time());
        }
        let now = unsafe { self.player.currentTime() };
        if !unsafe { self.output.hasNewPixelBufferForItemTime(now) } {
            return None;
        }
        let buffer = unsafe {
            self.output
                .copyPixelBufferForItemTime_itemTimeForDisplay(now, ptr::null_mut())
        }?;
        unsafe { CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags::ReadOnly) };
        let (width, height) = (
            CVPixelBufferGetWidth(&buffer),
            CVPixelBufferGetHeight(&buffer),
        );
        let stride = CVPixelBufferGetBytesPerRow(&buffer);
        let base = CVPixelBufferGetBaseAddress(&buffer).cast::<u8>();
        let frame = (!base.is_null()).then(|| {
            // SAFETY: the buffer is locked, and holds `height` rows of `stride` bytes.
            let bytes = unsafe { slice::from_raw_parts(base, stride * height) };
            shrink(bytes, width, height, stride, longest)
        });
        unsafe { CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags::ReadOnly) };
        frame.flatten()
    }
}

fn moment(seconds: f64) -> CMTime {
    CMTime {
        value: (seconds * 600.).round() as i64,
        timescale: 600,
        flags: CMTimeFlags::Valid,
        epoch: 0,
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.pause();
    }
}

/// Every nth pixel of 4-byte pixels in rows of `stride` bytes, n chosen so the longer side is at
/// most about `longest`. Video is already smooth, so skipping pixels looks fine at this size.
fn shrink(
    bytes: &[u8],
    width: usize,
    height: usize,
    stride: usize,
    longest: usize,
) -> Option<RgbaImage> {
    let step = width.max(height).div_ceil(longest.max(1)).max(1);
    let (to_width, to_height) = (width / step, height / step);
    let pixels: Vec<u8> = (0..to_height)
        .flat_map(|row| {
            let line = &bytes[row * step * stride..];
            (0..to_width).flat_map(move |column| {
                let at = column * step * 4;
                line[at..at + 4].iter().copied()
            })
        })
        .collect();
    RgbaImage::from_raw(to_width as u32, to_height as u32, pixels)
}
