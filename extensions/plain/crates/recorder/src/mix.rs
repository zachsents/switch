//! The sound of a recording's video: its audio sources mixed into one mono track at 48 kHz as
//! they arrive, so every player plays all of them. (Chrome only plays a video's first audio
//! track.)
//!
//! Each source is placed on the recording's timeline by when its audio started, like a
//! [`Track`](crate::track::Track): silence fills gaps, and audio overlapping what's already there
//! is trimmed. The mix moves on once every source has reached a moment, or once a source has
//! fallen a second behind the others, which is then taken to be silent until it catches up.

use std::{collections::VecDeque, iter};

/// Samples per second.
pub const RATE: u32 = 48_000;
/// Gaps and overlaps up to 10 ms are timing jitter, and left alone.
const SLACK: i64 = RATE as i64 / 100;
/// How far a source can fall behind the others, in samples, before it's taken to be silent.
const BEHIND: i64 = RATE as i64;

pub struct Mix {
    sources: Vec<Source>,
    /// Samples mixed so far.
    mixed: i64,
}

#[derive(Default)]
struct Source {
    /// What it has delivered past what's been mixed, at `RATE`.
    pending: VecDeque<f32>,
    resampler: Resampler,
}

impl Mix {
    /// A mix of `sources` sources, numbered from 0.
    pub fn new(sources: usize) -> Self {
        Self {
            sources: iter::repeat_with(Source::default).take(sources).collect(),
            mixed: 0,
        }
    }

    /// Samples mixed so far, which is where the next samples [`Mix::push`] returns start.
    pub fn mixed(&self) -> i64 {
        self.mixed
    }

    /// Adds source `source`'s `samples`, mono at `rate` samples per second, which started
    /// `offset` seconds into the recording. Returns what's been mixed since the last call.
    pub fn push(&mut self, source: usize, offset: f64, samples: &[f32], rate: f64) -> Vec<f32> {
        let written = self.mixed + self.sources[source].pending.len() as i64;
        let gap = (offset * f64::from(RATE)).round() as i64 - written;
        let source = &mut self.sources[source];
        if gap > SLACK {
            source.resampler = Resampler::default();
            source.pending.extend(iter::repeat_n(0., gap as usize));
        }
        let resampled = source.resampler.run(samples, rate / f64::from(RATE));
        let overlap = if gap < -SLACK { (-gap) as usize } else { 0 };
        source.pending.extend(resampled.into_iter().skip(overlap));

        let ahead = self.written().max().unwrap_or(self.mixed);
        self.pad(ahead - BEHIND);
        let ready = self.written().min().unwrap_or(self.mixed);
        self.take(ready - self.mixed)
    }

    /// The rest of the mix, with sources that ended early filled out with silence.
    pub fn finish(mut self) -> Vec<f32> {
        let end = self.written().max().unwrap_or(self.mixed);
        self.pad(end);
        self.take(end - self.mixed)
    }

    /// How far each source has delivered, in samples from the start.
    fn written(&self) -> impl Iterator<Item = i64> {
        self.sources
            .iter()
            .map(|source| self.mixed + source.pending.len() as i64)
    }

    /// Fills each source that hasn't reached `until` with silence up to it.
    fn pad(&mut self, until: i64) {
        for source in &mut self.sources {
            let missing = until - self.mixed - source.pending.len() as i64;
            if missing > 0 {
                source.resampler = Resampler::default();
                source.pending.extend(iter::repeat_n(0., missing as usize));
            }
        }
    }

    fn take(&mut self, count: i64) -> Vec<f32> {
        let count = count.max(0);
        let mixed = (0..count)
            .map(|_| {
                self.sources
                    .iter_mut()
                    .filter_map(|source| source.pending.pop_front())
                    .sum::<f32>()
                    .clamp(-1., 1.)
            })
            .collect();
        self.mixed += count;
        mixed
    }
}

/// Changes a source's sample rate to `RATE` by linear interpolation, carrying its place from
/// one buffer to the next.
#[derive(Default)]
struct Resampler {
    /// Where the next output sample falls, in input samples from the start of the next buffer,
    /// where -1 is the last sample of the buffer before.
    at: f64,
    last: f32,
}

impl Resampler {
    /// `step` is input samples per output sample.
    fn run(&mut self, input: &[f32], step: f64) -> Vec<f32> {
        let Some(&last) = input.last() else {
            return Vec::new();
        };
        let before = self.last;
        let sample = |index: isize| {
            usize::try_from(index)
                .ok()
                .and_then(|index| input.get(index).copied())
                .unwrap_or(before)
        };
        let end = (input.len() - 1) as f64;
        let mut output = Vec::with_capacity((input.len() as f64 / step) as usize + 1);
        while self.at <= end {
            let index = self.at.floor() as isize;
            let fraction = (self.at - self.at.floor()) as f32;
            let (from, to) = (sample(index), input.get((index + 1) as usize).copied());
            output.push(from + (to.unwrap_or(from) - from) * fraction);
            self.at += step;
        }
        self.at -= input.len() as f64;
        self.last = last;
        output
    }
}
