//! Recording the screen or one window, with system audio and the microphone, through
//! ScreenCaptureKit.
//!
//! One stream feeds two kinds of output:
//! - A [`Writer`] makes the video: HEVC MP4 at a constant quality, with the system audio and
//!   the microphone mixed together, so it plays in QuickTime, Safari and Chrome.
//! - The system audio and the microphone also each go to a [`Track`], a small MP3 for
//!   transcription. Keeping them apart is what tells "you" from everyone else.

use std::{
    path::PathBuf,
    ptr::{self, NonNull},
    slice,
    sync::Mutex,
    time::Duration,
};

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use futures::{
    channel::oneshot,
    future::{Either, select},
};
use gpui::BackgroundExecutor;
use objc2::{
    AnyThread, DefinedClass, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject},
};
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_core_audio_types::{
    AudioBufferList, kAudioFormatFlagIsFloat, kAudioFormatFlagIsSignedInteger,
};
use objc2_core_foundation::{CFRetained, CGSize};
use objc2_core_graphics::{
    CGImage, CGMainDisplayID, kCGColorSpaceSRGB, kCGDisplayStreamYCbCrMatrix_ITU_R_709_2,
};
use objc2_core_media::{
    CMAudioFormatDescriptionGetStreamBasicDescription, CMBlockBuffer, CMClock, CMSampleBuffer,
    CMTime, CMTimeFlags,
};
use objc2_core_video::kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSString};
use objc2_screen_capture_kit::{
    SCContentFilter, SCFrameStatus, SCScreenshotManager, SCShareableContent, SCStream,
    SCStreamConfiguration, SCStreamDelegate, SCStreamErrorCode, SCStreamFrameInfoStatus,
    SCStreamOutput, SCStreamOutputType,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use imaging::RgbaImage;

use crate::{track::Track, writer::Writer};

const SCREEN_DENIED: &str = "Recorder needs permission to record the screen. Turn it on in \
     System Settings > Privacy & Security > Screen & System Audio Recording, then try again.";
const MICROPHONE_DENIED: &str = "Recorder needs permission to use the microphone. Turn it on \
     in System Settings > Privacy & Security > Microphone, or record without it.";

/// Something to record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// A whole screen, by its id from the state's `sources`.
    Screen(u32),
    /// One window, by its id from the state's `sources`. Only that window is recorded, even
    /// with other windows in front of it.
    Window(u32),
}

/// What can be recorded right now.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Sources {
    /// The main screen first.
    pub screens: Vec<Screen>,
    /// Front to back.
    pub windows: Vec<Window>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Screen {
    pub id: u32,
    /// In points.
    pub width: i64,
    pub height: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Window {
    pub id: u32,
    pub app: String,
    pub title: String,
}

/// How to record.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    pub source: Source,
    pub microphone: bool,
    pub system_audio: bool,
}

/// Where a recording's files go.
#[derive(Clone, Debug)]
pub struct Files {
    pub video: PathBuf,
    pub system_audio: PathBuf,
    pub microphone: PathBuf,
}

/// The screens and windows that can be recorded. Asks for Screen Recording permission the first
/// time.
pub async fn sources() -> Result<Sources, String> {
    let content = shareable_content().await?.0;
    let own = std::process::id() as i32;
    let main = CGMainDisplayID();
    let mut screens: Vec<_> = unsafe { content.displays() }
        .iter()
        .map(|display| Screen {
            id: unsafe { display.displayID() },
            width: unsafe { display.width() } as i64,
            height: unsafe { display.height() } as i64,
        })
        .collect();
    screens.sort_by_key(|screen| screen.id != main);
    let windows = unsafe { content.windows() }
        .iter()
        .filter_map(|window| {
            let app = unsafe { window.owningApplication() }?;
            let size = unsafe { window.frame() }.size;
            let recordable = unsafe { window.windowLayer() } == 0
                && unsafe { app.processID() } != own
                && size.width >= 100.
                && size.height >= 60.;
            recordable.then(|| Window {
                id: unsafe { window.windowID() },
                app: unsafe { app.applicationName() }.to_string(),
                title: unsafe { window.title() }
                    .map(|title| title.to_string())
                    .unwrap_or_default(),
            })
        })
        .filter(|window| !window.app.is_empty())
        .collect();
    Ok(Sources { screens, windows })
}

/// A still of what `source` shows right now, its longer side at most `longest` pixels. Recorder's
/// own windows aren't in it.
pub async fn snapshot(source: Source, longest: f64) -> Result<RgbaImage, String> {
    let content = shareable_content().await?.0;
    let filter = filter(&content, source)?;
    let size = unsafe { filter.contentRect() }.size;
    let scale =
        (longest / size.width.max(size.height)).min(f64::from(unsafe { filter.pointPixelScale() }));
    let configuration = unsafe { SCStreamConfiguration::new() };
    unsafe {
        configuration.setWidth((size.width * scale).round().max(1.) as usize);
        configuration.setHeight((size.height * scale).round().max(1.) as usize);
        configuration.setShowsCursor(false);
        configuration.setIgnoreShadowsSingleWindow(true);
    }
    let (sender, receiver) = oneshot::channel();
    let reply = once(sender);
    let handler = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        reply(match unsafe { image.as_ref() } {
            Some(image) => Ok(imaging::from_cg_image(image)),
            None => {
                Err(unsafe { error.as_ref() }.map_or_else(|| "Nothing to show".into(), describe))
            }
        });
    });
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
            &filter,
            &configuration,
            Some(&handler),
        );
    }
    receiver
        .await
        .map_err(|_| "Couldn't capture a still".to_string())?
}

/// A recording in progress. Stop it with [`Capture::stop`] to finish its files.
pub struct Capture {
    stream: Retained<SCStream>,
    output: Retained<Output>,
    _queue: DispatchRetained<DispatchQueue>,
    interrupted: Option<oneshot::Receiver<String>>,
}

impl Capture {
    /// Starts recording. Asks for microphone permission first if it's needed and hasn't been
    /// asked for yet.
    pub async fn start(settings: Settings, files: &Files) -> Result<Self, String> {
        if settings.microphone {
            microphone_access().await?;
        }
        let content = shareable_content().await?.0;
        let filter = filter(&content, settings.source)?;
        let (width, height) = video_size(unsafe { filter.contentRect() }.size, unsafe {
            filter.pointPixelScale()
        });
        let configuration = configuration(width, height, settings);
        let track = |wanted: bool, path| wanted.then(|| Track::create(path)).transpose();
        let sources = usize::from(settings.system_audio) + usize::from(settings.microphone);
        let (interrupted_sender, interrupted) = oneshot::channel();
        let output = Output::new(Shared {
            writers: Mutex::new(Writers {
                video: Some(Writer::create(&files.video, width, height, sources)?),
                system_audio: track(settings.system_audio, &files.system_audio)?,
                microphone: track(settings.microphone, &files.microphone)?,
                ..Writers::default()
            }),
            interrupted: Mutex::new(Some(interrupted_sender)),
        });
        let (stream, queue) = match open(&filter, &configuration, &output, settings).await {
            Ok(opened) => opened,
            Err(error) => {
                let writers = output.ivars().writers.lock();
                if let Some(video) = writers.ok().and_then(|mut writers| writers.video.take()) {
                    video.cancel();
                }
                return Err(error);
            }
        };
        Ok(Self {
            stream,
            output,
            _queue: queue,
            interrupted: Some(interrupted),
        })
    }

    /// Resolves with the reason if recording stops on its own, like when the window being
    /// recorded closes or someone stops it from the menu bar. Can be taken once.
    pub fn interrupted(&mut self) -> Option<oneshot::Receiver<String>> {
        self.interrupted.take()
    }

    /// Stops recording and finishes the video and audio files.
    pub async fn stop(self, executor: &BackgroundExecutor) -> Result<(), String> {
        // The video lasts until now, even when the screen hasn't changed since its last frame.
        let stopped_at = unsafe { CMClock::host_time_clock().time() };
        let (sender, stopped) = oneshot::channel();
        let reply = once(sender);
        let handler = RcBlock::new(move |_: *mut NSError| reply(()));
        unsafe { self.stream.stopCaptureWithCompletionHandler(Some(&handler)) };
        select(stopped, executor.timer(Duration::from_secs(5))).await;

        // Nothing more arrives once the stream has stopped.
        let writers = self
            .output
            .ivars()
            .writers
            .lock()
            .map(|mut writers| std::mem::take(&mut *writers))
            .unwrap_or_default();
        let audio = [writers.system_audio, writers.microphone]
            .into_iter()
            .flatten()
            .try_for_each(Track::finish)
            .map_err(|error| format!("Couldn't save the audio for transcription: {error}"));
        let video = match (writers.video, writers.origin) {
            (Some(video), Some(origin)) => {
                let duration = unsafe { stopped_at.subtract(origin).seconds() };
                let finished = video.finish(duration);
                match select(finished, executor.timer(Duration::from_secs(20))).await {
                    Either::Left((Ok(result), _)) => result,
                    Either::Left((Err(_), _)) => Err("The video wasn't finished".into()),
                    Either::Right(_) => Err("The video took too long to finish".into()),
                }
            }
            (Some(video), None) => {
                video.cancel();
                Err("Nothing was recorded".into())
            }
            (None, _) => Ok(()),
        };
        video?;
        audio?;
        writers.failure.map_or(Ok(()), Err)
    }
}

/// Starts a stream of what `filter` shows, and the sound asked for, into `output`.
async fn open(
    filter: &SCContentFilter,
    configuration: &SCStreamConfiguration,
    output: &Output,
    settings: Settings,
) -> Result<(Retained<SCStream>, DispatchRetained<DispatchQueue>), String> {
    let stream = unsafe {
        SCStream::initWithFilter_configuration_delegate(
            SCStream::alloc(),
            filter,
            configuration,
            Some(ProtocolObject::from_ref(output)),
        )
    };
    let queue = DispatchQueue::new("com.plain.recorder.capture", None);
    let kinds = [
        (true, SCStreamOutputType::Screen),
        (settings.system_audio, SCStreamOutputType::Audio),
        (settings.microphone, SCStreamOutputType::Microphone),
    ];
    for (_, kind) in kinds.into_iter().filter(|(wanted, _)| *wanted) {
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(output),
                kind,
                Some(&queue),
            )
        }
        .map_err(|error| describe(&error))?;
    }

    let (sender, started) = oneshot::channel();
    let reply = once(sender);
    let handler = RcBlock::new(move |error: *mut NSError| {
        reply(unsafe { error.as_ref() }.map(describe));
    });
    unsafe { stream.startCaptureWithCompletionHandler(Some(&handler)) };
    match started.await {
        Ok(None) => Ok((stream, queue)),
        Ok(Some(error)) => Err(error),
        Err(_) => Err("Recording didn't start".into()),
    }
}

/// ScreenCaptureKit's current view of the screens, windows and apps.
async fn shareable_content() -> Result<Unsent<Retained<SCShareableContent>>, String> {
    let (sender, receiver) = oneshot::channel();
    let reply = once(sender);
    let handler = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            reply(match unsafe { Retained::retain(content) } {
                Some(content) => Ok(Unsent(content)),
                None => Err(unsafe { error.as_ref() }.map_or(SCREEN_DENIED.into(), describe)),
            });
        },
    );
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true, true, &handler,
        );
    }
    receiver
        .await
        .map_err(|_| "Couldn't list what can be recorded".to_string())?
}

fn filter(
    content: &SCShareableContent,
    source: Source,
) -> Result<Retained<SCContentFilter>, String> {
    match source {
        Source::Window(id) => {
            let window = unsafe { content.windows() }
                .iter()
                .find(|window| unsafe { window.windowID() } == id)
                .ok_or("That window isn't open anymore")?;
            Ok(unsafe {
                SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
            })
        }
        Source::Screen(id) => {
            let display = unsafe { content.displays() }
                .iter()
                .find(|display| unsafe { display.displayID() } == id)
                .ok_or("That screen isn't connected anymore")?;
            // Recorder's own windows and menu bar item stay out of the recording.
            let own = std::process::id() as i32;
            let apps: Vec<_> = unsafe { content.applications() }
                .iter()
                .filter(|app| unsafe { app.processID() } == own)
                .collect();
            Ok(unsafe {
                SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                    SCContentFilter::alloc(),
                    &display,
                    &NSArray::from_retained_slice(&apps),
                    &NSArray::new(),
                )
            })
        }
    }
}

fn configuration(
    width: usize,
    height: usize,
    settings: Settings,
) -> Retained<SCStreamConfiguration> {
    let configuration = unsafe { SCStreamConfiguration::new() };
    unsafe {
        configuration.setWidth(width);
        configuration.setHeight(height);
        // What the encoder takes, in sRGB, whose colors are the BT.709 the video is tagged with.
        configuration.setPixelFormat(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange);
        configuration.setColorMatrix(kCGDisplayStreamYCbCrMatrix_ITU_R_709_2);
        configuration.setColorSpaceName(kCGColorSpaceSRGB);
        // The encoder holds a few frames while it compares them, more than the default 3.
        configuration.setQueueDepth(6);
        configuration.setMinimumFrameInterval(CMTime {
            value: 1,
            timescale: 30,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        });
        configuration.setShowsCursor(true);
        configuration.setShowMouseClicks(true);
        configuration.setCapturesAudio(settings.system_audio);
        configuration.setSampleRate(48_000);
        configuration.setChannelCount(2);
        configuration.setExcludesCurrentProcessAudio(true);
        configuration.setCaptureMicrophone(settings.microphone);
    }
    configuration
}

/// The video's size in pixels: the source at full resolution, shrunk if needed to fit 4K so
/// every player takes it. Both sides are even, which the encoder needs.
fn video_size(points: CGSize, scale: f32) -> (usize, usize) {
    let (width, height) = (
        points.width * f64::from(scale),
        points.height * f64::from(scale),
    );
    let shrink = (3840. / width.max(height))
        .min(2160. / width.min(height))
        .min(1.);
    let even = |side: f64| ((side * shrink / 2.).round() * 2.).max(2.) as usize;
    (even(width), even(height))
}

async fn microphone_access() -> Result<(), String> {
    let audio = unsafe { AVMediaTypeAudio }.ok_or(MICROPHONE_DENIED)?;
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) } {
        AVAuthorizationStatus::Authorized => Ok(()),
        AVAuthorizationStatus::NotDetermined => {
            let (sender, receiver) = oneshot::channel();
            let reply = once(sender);
            let handler = RcBlock::new(move |granted: Bool| reply(granted.as_bool()));
            unsafe {
                AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler)
            };
            match receiver.await {
                Ok(true) => Ok(()),
                _ => Err(MICROPHONE_DENIED.into()),
            }
        }
        _ => Err(MICROPHONE_DENIED.into()),
    }
}

fn describe(error: &NSError) -> String {
    if error.code() == SCStreamErrorCode::UserDeclined.0 {
        SCREEN_DENIED.into()
    } else {
        error.localizedDescription().to_string()
    }
}

/// Turns a one-shot sender into the `Fn` that Objective-C completion blocks need. Only the
/// first call sends anything.
pub(crate) fn once<T>(sender: oneshot::Sender<T>) -> impl Fn(T) {
    let sender = Mutex::new(Some(sender));
    move |value| send(&sender, value)
}

fn send<T>(slot: &Mutex<Option<oneshot::Sender<T>>>, value: T) {
    if let Some(sender) = slot.lock().ok().and_then(|mut slot| slot.take()) {
        sender.send(value).ok();
    }
}

/// Hands a ScreenCaptureKit object from its callback thread to the thread that asked for it.
struct Unsent<T>(T);

// SAFETY: ScreenCaptureKit's content snapshots don't change once delivered, and each is handed
// over once, never used from two threads at a time.
unsafe impl<T> Send for Unsent<T> {}

/// What the capture callbacks share. They run on ScreenCaptureKit's threads.
struct Shared {
    writers: Mutex<Writers>,
    interrupted: Mutex<Option<oneshot::Sender<String>>>,
}

/// Where the stream's samples go.
#[derive(Default)]
struct Writers {
    /// When the first sample of any kind arrived, on the host clock. Everything is timed from
    /// it.
    origin: Option<CMTime>,
    video: Option<Writer>,
    system_audio: Option<Track>,
    microphone: Option<Track>,
    /// The first error writing a file.
    failure: Option<String>,
}

impl Shared {
    fn receive(&self, buffer: &CMSampleBuffer, kind: SCStreamOutputType) {
        if !unsafe { buffer.is_valid() } || kind == SCStreamOutputType::Screen && !changed(buffer) {
            return;
        }
        let time = unsafe { buffer.presentation_time_stamp() };
        let Ok(mut writers) = self.writers.lock() else {
            return;
        };
        let Writers {
            origin,
            video,
            system_audio,
            microphone,
            failure,
        } = &mut *writers;
        let at = unsafe { time.subtract(*origin.get_or_insert(time)) };
        let written = match kind {
            SCStreamOutputType::Screen => video
                .as_mut()
                .map_or(Ok(()), |video| video.frame(buffer, at)),
            SCStreamOutputType::Audio | SCStreamOutputType::Microphone => {
                let Some((samples, rate)) = mono_samples(buffer) else {
                    return;
                };
                let offset = unsafe { at.seconds() };
                // The video's mix has the system audio first, when it's recorded.
                let (track, source) = if kind == SCStreamOutputType::Audio {
                    (system_audio.as_mut(), 0)
                } else {
                    (microphone.as_mut(), usize::from(system_audio.is_some()))
                };
                if let Some(Err(error)) = track.map(|track| track.push(offset, &samples, rate)) {
                    failure.get_or_insert_with(|| format!("Couldn't save audio: {error}"));
                }
                video
                    .as_mut()
                    .map_or(Ok(()), |video| video.sound(source, offset, &samples, rate))
            }
            _ => Ok(()),
        };
        // A video that can't be written stops the recording, as running out of disk space does.
        if let Err(error) = written {
            failure.get_or_insert_with(|| error.clone());
            drop(writers);
            send(&self.interrupted, error);
        }
    }
}

/// Whether a frame of the screen shows something new. ScreenCaptureKit also sends frames that
/// only say nothing has changed, with no picture.
fn changed(buffer: &CMSampleBuffer) -> bool {
    let Some(attachments) = (unsafe { buffer.sample_attachments_array(false) }) else {
        return false;
    };
    // SAFETY: CFArray and CFDictionary are toll-free bridged with NSArray and NSDictionary.
    let attachments = unsafe {
        &*CFRetained::as_ptr(&attachments)
            .as_ptr()
            .cast::<NSArray<NSDictionary<NSString, AnyObject>>>()
    };
    attachments
        .firstObject()
        .and_then(|info| info.objectForKey(unsafe { SCStreamFrameInfoStatus }))
        .and_then(|status| status.downcast::<NSNumber>().ok())
        .is_some_and(|status| status.integerValue() == SCFrameStatus::Complete.0)
}

/// An audio buffer's samples mixed down to mono, with their sample rate. Handles the 32-bit
/// float and 16-bit integer PCM that ScreenCaptureKit delivers, interleaved or not.
fn mono_samples(buffer: &CMSampleBuffer) -> Option<(Vec<f32>, f64)> {
    let format = unsafe { buffer.format_description() }?;
    let description =
        unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&format).as_ref() }?;
    let frames = usize::try_from(unsafe { buffer.num_samples() }).ok()?;
    let mut size = 0;
    unsafe {
        buffer.audio_buffer_list_with_retained_block_buffer(
            &mut size,
            ptr::null_mut(),
            0,
            None,
            None,
            0,
            ptr::null_mut(),
        )
    };
    // u64s, so the list's pointers are aligned.
    let mut storage = vec![0_u64; size.div_ceil(8)];
    let list = storage.as_mut_ptr().cast::<AudioBufferList>();
    let mut block: *mut CMBlockBuffer = ptr::null_mut();
    let status = unsafe {
        buffer.audio_buffer_list_with_retained_block_buffer(
            ptr::null_mut(),
            list,
            size,
            None,
            None,
            0,
            &mut block,
        )
    };
    // Holds the samples the list points into until this returns.
    let _block = NonNull::new(block).map(|block| unsafe { CFRetained::from_raw(block) });
    if status != 0 {
        return None;
    }
    let list = unsafe { &*list };
    let buffers =
        unsafe { slice::from_raw_parts(list.mBuffers.as_ptr(), list.mNumberBuffers as usize) };
    let float = description.mFormatFlags & kAudioFormatFlagIsFloat != 0;
    let integer = description.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0;
    let mut mono = vec![0_f32; frames];
    for audio in buffers.iter().filter(|audio| !audio.mData.is_null()) {
        let channels = audio.mNumberChannels.max(1) as usize;
        let bytes = audio.mDataByteSize as usize;
        match description.mBitsPerChannel {
            32 if float => {
                let data = unsafe { slice::from_raw_parts(audio.mData.cast::<f32>(), bytes / 4) };
                mix(data, channels, &mut mono, |sample| sample);
            }
            16 if integer => {
                let data = unsafe { slice::from_raw_parts(audio.mData.cast::<i16>(), bytes / 2) };
                mix(data, channels, &mut mono, |sample| {
                    f32::from(sample) / 32_768.
                });
            }
            _ => return None,
        }
    }
    let scale = 1. / description.mChannelsPerFrame.max(1) as f32;
    mono.iter_mut().for_each(|sample| *sample *= scale);
    Some((mono, description.mSampleRate))
}

/// Adds every channel of interleaved `data` into `mono`.
fn mix<T: Copy>(data: &[T], channels: usize, mono: &mut [f32], to_float: impl Fn(T) -> f32) {
    for (sum, frame) in mono.iter_mut().zip(data.chunks_exact(channels)) {
        *sum += frame.iter().map(|&sample| to_float(sample)).sum::<f32>();
    }
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and Output doesn't implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "PlainRecorderCapture"]
    #[ivars = Shared]
    struct Output;

    unsafe impl NSObjectProtocol for Output {}

    unsafe impl SCStreamOutput for Output {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_did_output(
            &self,
            _stream: &SCStream,
            buffer: &CMSampleBuffer,
            kind: SCStreamOutputType,
        ) {
            self.ivars().receive(buffer, kind);
        }
    }

    unsafe impl SCStreamDelegate for Output {
        #[unsafe(method(stream:didStopWithError:))]
        fn stream_did_stop(&self, _stream: &SCStream, error: &NSError) {
            send(&self.ivars().interrupted, describe(error));
        }
    }
);

impl Output {
    fn new(shared: Shared) -> Retained<Self> {
        let this = Self::alloc().set_ivars(shared);
        unsafe { msg_send![super(this), init] }
    }
}
