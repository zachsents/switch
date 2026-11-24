//! A recording's video file, written with AVFoundation: the screen in HEVC at a constant
//! quality, and its sound mixed into one AAC track (see [`Mix`]).
//!
//! ScreenCaptureKit's own recorder, SCRecordingOutput, takes a codec but no quality or bitrate,
//! and picks its bitrate from the picture's size: HEVC came out the same size as H.264, about
//! 10 MB a minute at 1080p and 48 for a meeting at 3336 × 2160. A constant quality spends bits
//! only where the picture changes, and a meeting's screen mostly doesn't, so text stays as sharp
//! in a fraction of the size: 1.6 MB a minute for the same 1080p screen.

use std::{
    path::Path,
    ptr::{self, NonNull},
};

use block2::RcBlock;
use futures::channel::oneshot;
use objc2::{AnyThread, rc::Retained, runtime::AnyObject};
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAssetWriterStatus, AVFileTypeMPEG4, AVMediaTypeAudio,
    AVMediaTypeVideo, AVVideoCodecKey, AVVideoCodecTypeHEVC, AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoColorPrimariesKey, AVVideoColorPropertiesKey, AVVideoCompressionPropertiesKey,
    AVVideoExpectedSourceFrameRateKey, AVVideoHeightKey, AVVideoMaxKeyFrameIntervalDurationKey,
    AVVideoQualityKey, AVVideoTransferFunction_ITU_R_709_2, AVVideoTransferFunctionKey,
    AVVideoWidthKey, AVVideoYCbCrMatrix_ITU_R_709_2, AVVideoYCbCrMatrixKey,
};
use objc2_avf_audio::{AVEncoderBitRateKey, AVFormatIDKey, AVNumberOfChannelsKey, AVSampleRateKey};
use objc2_core_audio_types::{
    AudioStreamBasicDescription, kAudioFormatFlagIsFloat, kAudioFormatFlagIsPacked,
    kAudioFormatLinearPCM, kAudioFormatMPEG4AAC,
};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{
    CMAudioFormatDescriptionCreate, CMAudioSampleBufferCreateReadyWithPacketDescriptions,
    CMBlockBuffer, CMFormatDescription, CMSampleBuffer, CMSampleTimingInfo, CMTime,
    kCMBlockBufferAssureMemoryNowFlag, kCMTimeInvalid, kCMTimeZero,
};
use objc2_foundation::{NSDictionary, NSError, NSNumber, NSString, NSURL};

use crate::{
    capture::once,
    mix::{self, Mix},
};

/// How much of the picture's detail the encoder keeps, from 0 to 1. At 0.6, text on a 1080p
/// screen is as sharp as ScreenCaptureKit's own recording.
const QUALITY: f64 = 0.6;
/// The longest stretch between frames that can be shown without the ones before, in seconds.
/// Each is a whole screen's worth, so a still screen costs little more than these, and seeking
/// decodes at most this far.
const KEY_FRAMES: f64 = 4.;
/// Mono AAC at this many bits a second carries voices and music without artifacts.
const AUDIO_BITRATE: f64 = 96_000.;

pub struct Writer {
    writer: Retained<AVAssetWriter>,
    video: Retained<AVAssetWriterInput>,
    audio: Option<Audio>,
    /// When the last frame or sound written ends, in seconds from the start.
    end: f64,
}

struct Audio {
    input: Retained<AVAssetWriterInput>,
    /// Mono 32-bit float PCM at the mix's rate, the samples handed to the input.
    format: CFRetained<CMFormatDescription>,
    mix: Mix,
}

impl Writer {
    /// Starts an MP4 at `path`, `width` by `height` pixels, with sound from `sources` audio
    /// sources, or none. Everything added is timed from the start of the recording.
    pub fn create(
        path: &Path,
        width: usize,
        height: usize,
        sources: usize,
    ) -> Result<Self, String> {
        let unsupported = || "This Mac can't write HEVC video".to_string();
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let mp4 = unsafe { AVFileTypeMPEG4 }.ok_or_else(unsupported)?;
        let writer =
            unsafe { AVAssetWriter::initWithURL_fileType_error(AVAssetWriter::alloc(), &url, mp4) }
                .map_err(|error| describe(&error))?;

        let settings = video_settings(width, height).ok_or_else(unsupported)?;
        let video = input(
            &writer,
            unsafe { AVMediaTypeVideo }.ok_or_else(unsupported)?,
            &settings,
            None,
        )?;
        let audio = if sources > 0 {
            let format = pcm_format()?;
            let settings = audio_settings().ok_or_else(unsupported)?;
            let input = input(
                &writer,
                unsafe { AVMediaTypeAudio }.ok_or_else(unsupported)?,
                &settings,
                Some(&format),
            )?;
            Some(Audio {
                input,
                format,
                mix: Mix::new(sources),
            })
        } else {
            None
        };

        if !unsafe { writer.startWriting() } {
            return Err(failure(&writer));
        }
        unsafe { writer.startSessionAtSourceTime(kCMTimeZero) };
        Ok(Self {
            writer,
            video,
            audio,
            end: 0.,
        })
    }

    /// Adds a frame of the screen, shown `at` into the recording. Frames that come faster than
    /// the encoder takes them are dropped.
    pub fn frame(&mut self, buffer: &CMSampleBuffer, at: CMTime) -> Result<(), String> {
        if !unsafe { self.video.isReadyForMoreMediaData() } {
            return Ok(());
        }
        let timing = CMSampleTimingInfo {
            duration: unsafe { kCMTimeInvalid },
            presentationTimeStamp: at,
            decodeTimeStamp: unsafe { kCMTimeInvalid },
        };
        let mut retimed = ptr::null_mut();
        let status = unsafe {
            CMSampleBuffer::create_copy_with_new_timing(
                None,
                buffer,
                1,
                &timing,
                NonNull::from(&mut retimed),
            )
        };
        let retimed = NonNull::new(retimed)
            .filter(|_| status == 0)
            .map(|retimed| unsafe { CFRetained::from_raw(retimed) })
            .ok_or("Couldn't add a frame to the video")?;
        self.end = self.end.max(unsafe { at.seconds() });
        self.append(&self.video, &retimed)
    }

    /// Adds source `source`'s sound, mono at `rate` samples per second, which started `offset`
    /// seconds into the recording.
    pub fn sound(
        &mut self,
        source: usize,
        offset: f64,
        samples: &[f32],
        rate: f64,
    ) -> Result<(), String> {
        let Some(audio) = &mut self.audio else {
            return Ok(());
        };
        let start = audio.mix.mixed();
        let mixed = audio.mix.push(source, offset, samples, rate);
        self.write_sound(start, &mixed)
    }

    /// Finishes the file, lasting at least `duration` seconds. Resolves once it's written.
    pub fn finish(mut self, duration: f64) -> oneshot::Receiver<Result<(), String>> {
        let (sender, finished) = oneshot::channel();
        let rest = self.audio.take().map(|audio| {
            let start = audio.mix.mixed();
            let mixed = audio.mix.finish();
            (audio.input, audio.format, start, mixed)
        });
        let written = rest.map_or(Ok(()), |(input, format, start, mixed)| {
            let appended = sound_buffer(&format, start, &mixed)
                .map_or(Ok(()), |buffer| self.append(&input, &*buffer?));
            unsafe { input.markAsFinished() };
            self.end = self
                .end
                .max((start + mixed.len() as i64) as f64 / f64::from(mix::RATE));
            appended
        });
        if let Err(error) = written {
            unsafe { self.writer.cancelWriting() };
            sender.send(Err(error)).ok();
            return finished;
        }
        unsafe {
            self.video.markAsFinished();
            self.writer
                .endSessionAtSourceTime(CMTime::with_seconds(self.end.max(duration), 600));
        }
        let writer = self.writer.clone();
        let reply = once(sender);
        let handler = RcBlock::new(move || {
            reply(
                if unsafe { writer.status() } == AVAssetWriterStatus::Completed {
                    Ok(())
                } else {
                    Err(failure(&writer))
                },
            );
        });
        unsafe { self.writer.finishWritingWithCompletionHandler(&handler) };
        finished
    }

    /// Gives up on the file, as when nothing was recorded.
    pub fn cancel(self) {
        unsafe { self.writer.cancelWriting() };
    }

    fn write_sound(&mut self, start: i64, mixed: &[f32]) -> Result<(), String> {
        let Some(audio) = &self.audio else {
            return Ok(());
        };
        if !unsafe { audio.input.isReadyForMoreMediaData() } {
            return Ok(());
        }
        let Some(buffer) = sound_buffer(&audio.format, start, mixed) else {
            return Ok(());
        };
        let end = (start + mixed.len() as i64) as f64 / f64::from(mix::RATE);
        self.end = self.end.max(end);
        self.append(&audio.input, &*buffer?)
    }

    fn append(&self, input: &AVAssetWriterInput, buffer: &CMSampleBuffer) -> Result<(), String> {
        if unsafe { input.appendSampleBuffer(buffer) } {
            Ok(())
        } else {
            Err(failure(&self.writer))
        }
    }
}

fn input(
    writer: &AVAssetWriter,
    kind: &NSString,
    settings: &NSDictionary<NSString, AnyObject>,
    hint: Option<&CMFormatDescription>,
) -> Result<Retained<AVAssetWriterInput>, String> {
    if !unsafe { writer.canApplyOutputSettings_forMediaType(Some(settings), kind) } {
        return Err("This Mac can't write video like this".into());
    }
    let input = unsafe {
        AVAssetWriterInput::initWithMediaType_outputSettings_sourceFormatHint(
            AVAssetWriterInput::alloc(),
            kind,
            Some(settings),
            hint,
        )
    };
    unsafe { input.setExpectsMediaDataInRealTime(true) };
    if !unsafe { writer.canAddInput(&input) } {
        return Err("This Mac can't write video like this".into());
    }
    unsafe { writer.addInput(&input) };
    Ok(input)
}

/// HEVC at [`QUALITY`], tagged as the sRGB the screen is captured in (whose colors are BT.709's).
fn video_settings(
    width: usize,
    height: usize,
) -> Option<Retained<NSDictionary<NSString, AnyObject>>> {
    let number = NSNumber::new_f64;
    let color = NSDictionary::<NSString, AnyObject>::from_slices(
        &[
            unsafe { AVVideoColorPrimariesKey }?,
            unsafe { AVVideoTransferFunctionKey }?,
            unsafe { AVVideoYCbCrMatrixKey }?,
        ],
        &[
            unsafe { AVVideoColorPrimaries_ITU_R_709_2 }?.as_ref(),
            unsafe { AVVideoTransferFunction_ITU_R_709_2 }?.as_ref(),
            unsafe { AVVideoYCbCrMatrix_ITU_R_709_2 }?.as_ref(),
        ],
    );
    let (quality, key_frames, frame_rate) = (number(QUALITY), number(KEY_FRAMES), number(30.));
    let compression = NSDictionary::<NSString, AnyObject>::from_slices(
        &[
            unsafe { AVVideoQualityKey }?,
            unsafe { AVVideoMaxKeyFrameIntervalDurationKey }?,
            unsafe { AVVideoExpectedSourceFrameRateKey }?,
        ],
        &[quality.as_ref(), key_frames.as_ref(), frame_rate.as_ref()],
    );
    let (width, height) = (number(width as f64), number(height as f64));
    Some(NSDictionary::from_slices(
        &[
            unsafe { AVVideoCodecKey }?,
            unsafe { AVVideoWidthKey }?,
            unsafe { AVVideoHeightKey }?,
            unsafe { AVVideoColorPropertiesKey }?,
            unsafe { AVVideoCompressionPropertiesKey }?,
        ],
        &[
            unsafe { AVVideoCodecTypeHEVC }?.as_ref(),
            width.as_ref(),
            height.as_ref(),
            color.as_ref(),
            compression.as_ref(),
        ],
    ))
}

/// Mono AAC at the mix's rate.
fn audio_settings() -> Option<Retained<NSDictionary<NSString, AnyObject>>> {
    let (format, rate, channels, bitrate) = (
        NSNumber::new_u32(kAudioFormatMPEG4AAC),
        NSNumber::new_f64(f64::from(mix::RATE)),
        NSNumber::new_u32(1),
        NSNumber::new_f64(AUDIO_BITRATE),
    );
    Some(NSDictionary::from_slices(
        &[
            unsafe { AVFormatIDKey }?,
            unsafe { AVSampleRateKey }?,
            unsafe { AVNumberOfChannelsKey }?,
            unsafe { AVEncoderBitRateKey }?,
        ],
        &[
            format.as_ref(),
            rate.as_ref(),
            channels.as_ref(),
            bitrate.as_ref(),
        ],
    ))
}

fn pcm_format() -> Result<CFRetained<CMFormatDescription>, String> {
    let description = AudioStreamBasicDescription {
        mSampleRate: f64::from(mix::RATE),
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4,
        mFramesPerPacket: 1,
        mBytesPerFrame: 4,
        mChannelsPerFrame: 1,
        mBitsPerChannel: 32,
        mReserved: 0,
    };
    let mut format = ptr::null();
    let status = unsafe {
        CMAudioFormatDescriptionCreate(
            None,
            NonNull::from(&description),
            0,
            ptr::null(),
            0,
            ptr::null(),
            None,
            NonNull::from(&mut format),
        )
    };
    NonNull::new(format.cast_mut())
        .filter(|_| status == 0)
        .map(|format| unsafe { CFRetained::from_raw(format) })
        .ok_or_else(|| "Couldn't set up the video's sound".into())
}

/// A sample buffer holding `samples` of mixed sound that start `start` samples in, or None when
/// there are none.
fn sound_buffer(
    format: &CMFormatDescription,
    start: i64,
    samples: &[f32],
) -> Option<Result<CFRetained<CMSampleBuffer>, String>> {
    if samples.is_empty() {
        return None;
    }
    let failed = || "Couldn't add sound to the video".to_string();
    let bytes = size_of_val(samples);
    let mut block = ptr::null_mut();
    let status = unsafe {
        CMBlockBuffer::create_with_memory_block(
            None,
            ptr::null_mut(),
            bytes,
            None,
            ptr::null(),
            0,
            bytes,
            kCMBlockBufferAssureMemoryNowFlag,
            NonNull::from(&mut block),
        )
    };
    let Some(block) = NonNull::new(block).filter(|_| status == 0) else {
        return Some(Err(failed()));
    };
    let block: CFRetained<CMBlockBuffer> = unsafe { CFRetained::from_raw(block) };
    let copied = unsafe {
        CMBlockBuffer::replace_data_bytes(NonNull::from(samples).cast(), &block, 0, bytes)
    };
    let mut buffer = ptr::null_mut();
    let created = unsafe {
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            None,
            &block,
            format,
            samples.len() as isize,
            CMTime {
                value: start,
                timescale: mix::RATE as i32,
                flags: objc2_core_media::CMTimeFlags::Valid,
                epoch: 0,
            },
            ptr::null(),
            NonNull::from(&mut buffer),
        )
    };
    Some(
        NonNull::new(buffer)
            .filter(|_| copied == 0 && created == 0)
            .map(|buffer| unsafe { CFRetained::from_raw(buffer) })
            .ok_or_else(failed),
    )
}

fn failure(writer: &AVAssetWriter) -> String {
    unsafe { writer.error() }.map_or_else(
        || "The video couldn't be saved".into(),
        |error| describe(&error),
    )
}

fn describe(error: &NSError) -> String {
    error.localizedDescription().to_string()
}
