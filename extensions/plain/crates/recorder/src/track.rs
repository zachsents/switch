//! One audio source of a recording, kept as a small 16 kHz mono MP3 for transcription. Its
//! timeline matches the video's: silence fills gaps in what the source delivered, and audio that
//! arrives overlapping what's already written is trimmed. So phrases transcribed from different
//! tracks line up with each other and with the video.
//!
//! A track too long to transcribe in one request is [`split`] into overlapping pieces.

use std::{
    fs::File,
    io::{self, BufWriter, Write},
    path::Path,
};

use mp3lame_encoder::{Bitrate, Builder, Encoder, FlushNoGap, MonoPcm, Quality};

/// Samples per second in the MP3: plenty for speech, and what transcription models resample to
/// anyway.
pub const RATE: u32 = 16_000;
/// Gaps and overlaps up to 10 ms are timing jitter, and left alone.
const SLACK: i64 = RATE as i64 / 100;

pub struct Track {
    encoder: Encoder,
    file: BufWriter<File>,
    decimator: Decimator,
    /// Samples written so far, at `RATE`.
    written: i64,
    mp3: Vec<u8>,
}

impl Track {
    pub fn create(path: &Path) -> Result<Self, String> {
        let failed = |error: String| format!("Couldn't set up audio for transcription: {error}");
        let mut builder = Builder::new().ok_or_else(|| failed("no MP3 encoder".into()))?;
        builder
            .set_num_channels(1)
            .and_then(|()| builder.set_sample_rate(RATE))
            .and_then(|()| builder.set_brate(Bitrate::Kbps32))
            .and_then(|()| builder.set_quality(Quality::Good))
            .map_err(|error| failed(error.to_string()))?;
        let encoder = builder.build().map_err(|error| failed(error.to_string()))?;
        let file = File::create(path).map_err(|error| failed(error.to_string()))?;
        Ok(Self {
            encoder,
            file: BufWriter::new(file),
            decimator: Decimator::default(),
            written: 0,
            mp3: Vec::new(),
        })
    }

    /// Adds `samples`, mono at `rate` samples per second, which started `offset` seconds into
    /// the recording.
    pub fn push(&mut self, offset: f64, samples: &[f32], rate: f64) -> io::Result<()> {
        let step = rate / f64::from(RATE);
        let gap = (offset * f64::from(RATE)).round() as i64 - self.written;
        let samples = if gap > SLACK {
            self.decimator = Decimator::default();
            self.silence(gap)?;
            samples
        } else if gap < -SLACK {
            let overlap = ((-gap) as f64 * step).round() as usize;
            &samples[overlap.min(samples.len())..]
        } else {
            samples
        };
        let decimated = self.decimator.run(samples, step);
        self.encode(&decimated)
    }

    /// Writes the end of the MP3. Without this the last moments are lost.
    pub fn finish(mut self) -> io::Result<()> {
        self.mp3.clear();
        self.mp3.reserve(7200);
        self.encoder
            .flush_to_vec::<FlushNoGap>(&mut self.mp3)
            .map_err(|error| io::Error::other(error.to_string()))?;
        self.file.write_all(&self.mp3)?;
        self.file.flush()
    }

    fn silence(&mut self, samples: i64) -> io::Result<()> {
        let second = vec![0.; RATE as usize];
        let mut left = samples as usize;
        while left > 0 {
            let chunk = left.min(second.len());
            self.encode(&second[..chunk])?;
            left -= chunk;
        }
        Ok(())
    }

    fn encode(&mut self, samples: &[f32]) -> io::Result<()> {
        if samples.is_empty() {
            return Ok(());
        }
        self.mp3.clear();
        self.mp3
            .reserve(mp3lame_encoder::max_required_buffer_size(samples.len()));
        self.encoder
            .encode_to_vec(MonoPcm(samples), &mut self.mp3)
            .map_err(|error| io::Error::other(error.to_string()))?;
        self.written += samples.len() as i64;
        self.file.write_all(&self.mp3)
    }
}

/// A stretch of a track's MP3, cut at frame boundaries so it's an MP3 of its own.
#[derive(Debug)]
pub struct Piece<'a> {
    /// Seconds into the track.
    pub start: f64,
    pub end: f64,
    pub mp3: &'a [u8],
}

/// Cuts a track's MP3 into as few pieces of equal length as keeps each within `longest`
/// seconds and `largest` bytes, each sharing `overlap` seconds with its neighbors, which must be
/// well under `longest`. A track that already fits, or whose frames can't be read, stays whole.
pub fn split(mp3: &[u8], longest: f64, largest: usize, overlap: f64) -> Vec<Piece<'_>> {
    let frames = frames(mp3);
    let duration = frames.last().map_or(0., |&(_, time)| time);
    let longest = longest.min(largest as f64 * duration / mp3.len() as f64);
    if frames.len() < 2 || duration <= longest {
        return vec![Piece {
            start: 0.,
            end: duration,
            mp3,
        }];
    }
    let count = (duration / (longest - overlap)).ceil();
    let length = duration / count;
    (0..count as usize)
        .map(|index| {
            let from = index as f64 * length - overlap / 2.;
            let to = (index + 1) as f64 * length + overlap / 2.;
            // Rounded inward to frames, so a piece is never longer than planned.
            let first = frames.partition_point(|&(_, time)| time < from);
            let last = frames.partition_point(|&(_, time)| time <= to) - 1;
            Piece {
                start: frames[first].1,
                end: frames[last].1,
                mp3: &mp3[frames[first].0..frames[last].0],
            }
        })
        .collect()
}

/// Where each MPEG audio frame starts, in bytes and in seconds, ending with the end of the
/// file and the track's duration. Reads the Layer III frames tracks are made of, and stops at
/// anything else.
fn frames(mp3: &[u8]) -> Vec<(usize, f64)> {
    let mut frames = Vec::new();
    let (mut at, mut time) = (0, 0.);
    while let Some((bytes, seconds)) = mp3.get(at..).and_then(frame) {
        frames.push((at, time));
        at += bytes;
        time += seconds;
    }
    frames.push((mp3.len(), time));
    frames
}

/// The length in bytes and in seconds of the MPEG Layer III frame that `bytes` starts with.
fn frame(bytes: &[u8]) -> Option<(usize, f64)> {
    let &[0xFF, second, third, _, ..] = bytes else {
        return None;
    };
    let (sync, version, layer) = (second >> 5, (second >> 3) & 3, (second >> 1) & 3);
    // Versions are 0 for MPEG 2.5, 2 for MPEG 2 and 3 for MPEG 1. Layer III is 1.
    if sync != 7 || version == 1 || layer != 1 {
        return None;
    }
    let mpeg1 = version == 3;
    let kilobits: &[usize] = if mpeg1 {
        &[
            0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
        ]
    } else {
        &[0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    };
    let bitrate = 1000
        * kilobits
            .get(usize::from(third >> 4))
            .filter(|&&rate| rate > 0)?;
    let rate = [44_100, 48_000, 32_000].get(usize::from((third >> 2) & 3))? >> (3 - version.max(1));
    let samples = if mpeg1 { 1152 } else { 576 };
    let padding = usize::from((third >> 1) & 1);
    Some((
        samples / 8 * bitrate / rate + padding,
        samples as f64 / rate as f64,
    ))
}

/// Lowers the sample rate by averaging each run of input samples into one output sample, which
/// also filters out what the lower rate can't hold. Works for any ratio, like 44.1 to 16 kHz,
/// and carries a partial run over to the next buffer.
#[derive(Default)]
struct Decimator {
    /// Input samples in the current run, as a fraction of a step.
    filled: f64,
    sum: f32,
    count: u32,
}

impl Decimator {
    /// `step` is input samples per output sample.
    fn run(&mut self, input: &[f32], step: f64) -> Vec<f32> {
        let mut output = Vec::with_capacity((input.len() as f64 / step) as usize + 1);
        for &sample in input {
            self.sum += sample;
            self.count += 1;
            self.filled += 1.;
            if self.filled >= step {
                output.push(self.sum / self.count as f32);
                self.filled -= step;
                self.sum = 0.;
                self.count = 0;
            }
        }
        output
    }
}
