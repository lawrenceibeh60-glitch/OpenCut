//! Sample-accurate PCM mixing primitives.
//!
//! This crate operates on decoded interleaved floating-point PCM. It does not
//! decode compressed audio or open output devices; those belong to media and
//! platform adapters.

use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub struct AudioClip<'a> {
    pub source: &'a PcmBuffer,
    pub timeline_start_frame: usize,
    pub source_in_frame: usize,
    pub duration_frames: usize,
    pub gain_db: f32,
    pub pan: f32,
    pub enabled: bool,
}

pub struct PcmBuffer {
    sample_rate: u32,
    channels: u16,
    samples: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioError {
    InvalidFormat,
    InvalidSampleCount,
    NonFiniteSample,
    InvalidGain,
    InvalidPan,
    FormatMismatch,
    ClipOutOfBounds,
}

impl fmt::Display for AudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFormat => write!(f, "sample rate and channel count must be positive"),
            Self::InvalidSampleCount => write!(f, "interleaved sample count must be divisible by channel count"),
            Self::NonFiniteSample => write!(f, "PCM samples must be finite floating-point values"),
            Self::InvalidGain => write!(f, "gain must be finite and within the supported range"),
            Self::InvalidPan => write!(f, "stereo pan must be between -1 and 1"),
            Self::FormatMismatch => write!(f, "source and destination PCM formats must match"),
            Self::ClipOutOfBounds => write!(f, "audio clip source range exceeds its PCM buffer"),
        }
    }
}

impl std::error::Error for AudioError {}

impl PcmBuffer {
    pub fn new(sample_rate: u32, channels: u16, samples: Vec<f32>) -> Result<Self, AudioError> {
        if sample_rate == 0 || channels == 0 {
            return Err(AudioError::InvalidFormat);
        }
        if samples.len() % channels as usize != 0 {
            return Err(AudioError::InvalidSampleCount);
        }
        if samples.iter().any(|sample| !sample.is_finite()) {
            return Err(AudioError::NonFiniteSample);
        }
        Ok(Self { sample_rate, channels, samples })
    }

    pub fn silence(sample_rate: u32, channels: u16, frames: usize) -> Result<Self, AudioError> {
        if sample_rate == 0 || channels == 0 {
            return Err(AudioError::InvalidFormat);
        }
        let sample_count = frames.checked_mul(channels as usize).ok_or(AudioError::InvalidSampleCount)?;
        Self::new(sample_rate, channels, vec![0.0; sample_count])
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn frame_count(&self) -> usize {
        self.samples.len() / self.channels as usize
    }

    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    pub fn samples_mut(&mut self) -> &mut [f32] {
        &mut self.samples
    }

    pub fn peak(&self) -> f32 {
        self.samples.iter().fold(0.0_f32, |peak, sample| peak.max(sample.abs()))
    }

    pub fn rms(&self) -> f32 {
        if self.samples.is_empty() {
            return 0.0;
        }
        let mean_square = self.samples.iter().map(|sample| {
            let sample = *sample as f64;
            sample * sample
        }).sum::<f64>() / self.samples.len() as f64;
        mean_square.sqrt() as f32
    }

    pub fn apply_gain_db(&mut self, decibels: f32) -> Result<(), AudioError> {
        if !decibels.is_finite() || !(-120.0..=60.0).contains(&decibels) {
            return Err(AudioError::InvalidGain);
        }
        let gain = 10.0_f32.powf(decibels / 20.0);
        if !gain.is_finite() {
            return Err(AudioError::InvalidGain);
        }
        for sample in &mut self.samples {
            *sample *= gain;
        }
        Ok(())
    }

    pub fn fade_in(&mut self, frames: usize) {
        let count = frames.min(self.frame_count());
        if count == 0 {
            return;
        }
        for frame in 0..count {
            let gain = if count == 1 { 0.0 } else { frame as f32 / (count - 1) as f32 };
            self.scale_frame(frame, gain);
        }
    }

    pub fn fade_out(&mut self, frames: usize) {
        let count = frames.min(self.frame_count());
        if count == 0 {
            return;
        }
        let start = self.frame_count() - count;
        for offset in 0..count {
            let gain = if count == 1 { 0.0 } else { (count - offset - 1) as f32 / (count - 1) as f32 };
            self.scale_frame(start + offset, gain);
        }
    }

    /// Mix source PCM into this buffer at a frame offset. Floating-point headroom
    /// is preserved; clipping/limiting is intentionally a separate master stage.
    pub fn mix_from(
        &mut self,
        source: &PcmBuffer,
        start_frame: usize,
        gain: f32,
        pan: f32,
    ) -> Result<(), AudioError> {
        if self.sample_rate != source.sample_rate || self.channels != source.channels {
            return Err(AudioError::FormatMismatch);
        }
        if !gain.is_finite() || !(-16.0..=16.0).contains(&gain) {
            return Err(AudioError::InvalidGain);
        }
        if !pan.is_finite() || !(-1.0..=1.0).contains(&pan) {
            return Err(AudioError::InvalidPan);
        }

        self.mix_region_from(source, 0, source.frame_count(), start_frame, gain, pan)
    }

    pub fn mix_region_from(
        &mut self,
        source: &PcmBuffer,
        source_start_frame: usize,
        source_frame_count: usize,
        destination_start_frame: usize,
        gain: f32,
        pan: f32,
    ) -> Result<(), AudioError> {
        if self.sample_rate != source.sample_rate || self.channels != source.channels {
            return Err(AudioError::FormatMismatch);
        }
        if !gain.is_finite() || !(-16.0..=16.0).contains(&gain) {
            return Err(AudioError::InvalidGain);
        }
        if !pan.is_finite() || !(-1.0..=1.0).contains(&pan) {
            return Err(AudioError::InvalidPan);
        }
        let source_end = source_start_frame.checked_add(source_frame_count).ok_or(AudioError::ClipOutOfBounds)?;
        if source_end > source.frame_count() {
            return Err(AudioError::ClipOutOfBounds);
        }

        let channels = self.channels as usize;
        let available = self.frame_count().saturating_sub(destination_start_frame);
        let count = available.min(source_frame_count);
        let (left_pan, right_pan) = if channels == 2 {
            let angle = (pan + 1.0) * std::f32::consts::FRAC_PI_4;
            (angle.cos(), angle.sin())
        } else {
            (1.0, 1.0)
        };

        for frame in 0..count {
            for channel in 0..channels {
                let pan_gain = if channels == 2 {
                    if channel == 0 { left_pan } else { right_pan }
                } else {
                    1.0
                };
                let destination_index = (destination_start_frame + frame) * channels + channel;
                let source_index = (source_start_frame + frame) * channels + channel;
                self.samples[destination_index] += source.samples[source_index] * gain * pan_gain;
            }
        }
        Ok(())
    }

    fn scale_frame(&mut self, frame: usize, gain: f32) {
        let start = frame * self.channels as usize;
        let end = start + self.channels as usize;
        for sample in &mut self.samples[start..end] {
            *sample *= gain;
        }
    }
}

/// Render an audio timeline into an interleaved floating-point mix buffer.
pub fn mix_timeline(
    sample_rate: u32,
    channels: u16,
    total_frames: usize,
    clips: &[AudioClip<'_>],
) -> Result<PcmBuffer, AudioError> {
    let mut output = PcmBuffer::silence(sample_rate, channels, total_frames)?;
    for clip in clips {
        if !clip.enabled {
            continue;
        }
        if !clip.gain_db.is_finite() || !(-120.0..=60.0).contains(&clip.gain_db) {
            return Err(AudioError::InvalidGain);
        }
        let gain = 10.0_f32.powf(clip.gain_db / 20.0);
        output.mix_region_from(
            clip.source,
            clip.source_in_frame,
            clip.duration_frames,
            clip.timeline_start_frame,
            gain,
            clip.pan,
        )?;
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeline_mixer_respects_source_in_and_timeline_start() {
        let source = PcmBuffer::new(48_000, 1, vec![0.1, 0.2, 0.3, 0.4]).unwrap();
        let output = mix_timeline(48_000, 1, 5, &[AudioClip {
            source: &source, timeline_start_frame: 1, source_in_frame: 1,
            duration_frames: 2, gain_db: 0.0, pan: 0.0, enabled: true,
        }]).unwrap();
        assert_eq!(output.samples(), &[0.0, 0.2, 0.3, 0.0, 0.0]);
    }

    #[test]
    fn timeline_mixer_sums_overlapping_clips_and_skips_disabled_clips() {
        let source = PcmBuffer::new(48_000, 1, vec![0.25, 0.25]).unwrap();
        let output = mix_timeline(48_000, 1, 2, &[
            AudioClip { source: &source, timeline_start_frame: 0, source_in_frame: 0, duration_frames: 2, gain_db: 0.0, pan: 0.0, enabled: true },
            AudioClip { source: &source, timeline_start_frame: 0, source_in_frame: 0, duration_frames: 2, gain_db: 0.0, pan: 0.0, enabled: true },
            AudioClip { source: &source, timeline_start_frame: 0, source_in_frame: 0, duration_frames: 2, gain_db: 0.0, pan: 0.0, enabled: false },
        ]).unwrap();
        assert_eq!(output.samples(), &[0.5, 0.5]);
    }

    #[test]
    fn timeline_mixer_rejects_clip_source_overrun() {
        let source = PcmBuffer::new(48_000, 1, vec![0.1, 0.2]).unwrap();
        let result = mix_timeline(48_000, 1, 2, &[AudioClip {
            source: &source, timeline_start_frame: 0, source_in_frame: 1,
            duration_frames: 2, gain_db: 0.0, pan: 0.0, enabled: true,
        }]);
        assert_eq!(result, Err(AudioError::ClipOutOfBounds));
    }

    #[test]
    fn validates_pcm_format_and_interleaving() {
        assert_eq!(PcmBuffer::new(0, 2, vec![]), Err(AudioError::InvalidFormat));
        assert_eq!(PcmBuffer::new(48_000, 2, vec![0.0]), Err(AudioError::InvalidSampleCount));
        assert_eq!(PcmBuffer::new(48_000, 1, vec![f32::NAN]), Err(AudioError::NonFiniteSample));
    }

    #[test]
    fn computes_frame_count_peak_and_rms() {
        let buffer = PcmBuffer::new(48_000, 2, vec![0.5, -0.5, 1.0, -1.0]).unwrap();
        assert_eq!(buffer.frame_count(), 2);
        assert_eq!(buffer.peak(), 1.0);
        assert!((buffer.rms() - 0.7905694).abs() < 0.0001);
    }

    #[test]
    fn applies_decibel_gain() {
        let mut buffer = PcmBuffer::new(48_000, 1, vec![0.25, -0.25]).unwrap();
        buffer.apply_gain_db(6.0206).unwrap();
        assert!((buffer.samples()[0] - 0.5).abs() < 0.001);
        assert!((buffer.samples()[1] + 0.5).abs() < 0.001);
    }

    #[test]
    fn fade_in_and_out_are_frame_accurate() {
        let mut buffer = PcmBuffer::new(48_000, 1, vec![1.0; 5]).unwrap();
        buffer.fade_in(3);
        assert_eq!(&buffer.samples()[..3], &[0.0, 0.5, 1.0]);
        buffer.fade_out(2);
        assert_eq!(&buffer.samples()[3..], &[1.0, 0.0]);
    }

    #[test]
    fn mixes_at_frame_offset_without_clipping_headroom() {
        let mut destination = PcmBuffer::silence(48_000, 1, 4).unwrap();
        let source = PcmBuffer::new(48_000, 1, vec![0.75, 0.75, 0.75]).unwrap();
        destination.mix_from(&source, 1, 1.0, 0.0).unwrap();
        assert_eq!(destination.samples(), &[0.0, 0.75, 0.75, 0.75]);
    }

    #[test]
    fn stereo_equal_power_pan_moves_signal_between_channels() {
        let mut destination = PcmBuffer::silence(48_000, 2, 1).unwrap();
        let source = PcmBuffer::new(48_000, 2, vec![1.0, 1.0]).unwrap();
        destination.mix_from(&source, 0, 1.0, -1.0).unwrap();
        assert!((destination.samples()[0] - 1.0).abs() < 0.0001);
        assert!(destination.samples()[1].abs() < 0.0001);
    }

    #[test]
    fn stereo_center_pan_uses_equal_power_gains() {
        let mut destination = PcmBuffer::silence(48_000, 2, 1).unwrap();
        let source = PcmBuffer::new(48_000, 2, vec![1.0, 1.0]).unwrap();
        destination.mix_from(&source, 0, 1.0, 0.0).unwrap();
        let expected = std::f32::consts::FRAC_1_SQRT_2;
        assert!((destination.samples()[0] - expected).abs() < 0.0001);
        assert!((destination.samples()[1] - expected).abs() < 0.0001);
    }

    #[test]
    fn rejects_mismatched_format_and_invalid_pan() {
        let mut destination = PcmBuffer::silence(48_000, 2, 1).unwrap();
        let mono = PcmBuffer::new(48_000, 1, vec![1.0]).unwrap();
        assert_eq!(destination.mix_from(&mono, 0, 1.0, 0.0), Err(AudioError::FormatMismatch));
        let stereo = PcmBuffer::new(48_000, 2, vec![1.0, 1.0]).unwrap();
        assert_eq!(destination.mix_from(&stereo, 0, 1.0, 2.0), Err(AudioError::InvalidPan));
    }
}
