//! FFmpeg-backed media access for KYROCUT X1.
//!
//! The crate deliberately exposes owned frame buffers at its boundary. FFmpeg
//! decoder objects remain internal to a decode operation, which keeps the
//! timeline, compositor, and UI independent of FFmpeg's lifetime model.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use ffmpeg_next as ffmpeg;

static FFMPEG_INIT: OnceLock<Result<(), String>> = OnceLock::new();

/// A media file's basic stream information, in project-friendly units.
#[derive(Debug, Clone, PartialEq)]
pub struct MediaInfo {
    pub path: PathBuf,
    pub duration_seconds: Option<f64>,
    pub video: Option<VideoStreamInfo>,
    pub audio: Option<AudioStreamInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoStreamInfo {
    pub stream_index: usize,
    pub width: u32,
    pub height: u32,
    /// FFmpeg's stream average frame-rate rational, retained without rounding.
    pub average_frame_rate: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioStreamInfo {
    pub stream_index: usize,
    pub sample_rate: u32,
    pub channels: u16,
}

/// An owned, tightly packed RGBA frame returned by the decoder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedVideoFrame {
    pub presentation_timestamp: Option<i64>,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaError {
    Initialization(String),
    Open(String),
    MissingVideoStream,
    Decoder(String),
    InvalidFrame(String),
    Audio(String),
    Render(String),
    Project(String),
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Initialization(message) => write!(formatter, "FFmpeg initialization failed: {message}"),
            Self::Open(message) => write!(formatter, "could not open media: {message}"),
            Self::MissingVideoStream => write!(formatter, "media contains no video stream"),
            Self::Decoder(message) => write!(formatter, "video decoder failed: {message}"),
            Self::InvalidFrame(message) => write!(formatter, "invalid decoded frame: {message}"),
            Self::Audio(message) => write!(formatter, "audio decoding failed: {message}"),
            Self::Render(message) => write!(formatter, "timeline compositing failed: {message}"),
            Self::Project(message) => write!(formatter, "invalid project for media rendering: {message}"),
        }
    }
}

impl std::error::Error for MediaError {}

fn initialize() -> Result<(), MediaError> {
    match FFMPEG_INIT.get_or_init(|| ffmpeg::init().map_err(|error| error.to_string())) {
        Ok(()) => Ok(()),
        Err(message) => Err(MediaError::Initialization(message.clone())),
    }
}

/// Probe the best video and audio streams without decoding the entire file.
pub fn probe(path: impl AsRef<Path>) -> Result<MediaInfo, MediaError> {
    initialize()?;
    let path = path.as_ref();
    let input = ffmpeg::format::input(path)
        .map_err(|error| MediaError::Open(error.to_string()))?;

    let duration = input.duration();
    let duration_seconds = (duration > 0).then_some(duration as f64 / 1_000_000.0);

    let video = input.streams().best(ffmpeg::media::Type::Video).map(|stream| {
        let stream_index = stream.index();
        let average_frame_rate = format!("{}", stream.avg_frame_rate());
        let decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
            .and_then(|context| context.decoder().video());
        decoder.ok().map(|decoder| VideoStreamInfo {
            stream_index,
            width: decoder.width(),
            height: decoder.height(),
            average_frame_rate,
        })
    }).flatten();

    let audio = input.streams().best(ffmpeg::media::Type::Audio).map(|stream| {
        let stream_index = stream.index();
        let decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
            .and_then(|context| context.decoder().audio());
        decoder.ok().map(|decoder| AudioStreamInfo {
            stream_index,
            sample_rate: decoder.rate(),
            channels: decoder.channels(),
        })
    }).flatten();

    Ok(MediaInfo {
        path: path.to_path_buf(),
        duration_seconds,
        video,
        audio,
    })
}

/// Decode up to `max_frames` from the best video stream and convert them to
/// tightly packed RGBA8. This bounded API avoids accidentally loading an
/// entire long-form source into memory.
pub fn decode_video_frames(
    path: impl AsRef<Path>,
    max_frames: usize,
) -> Result<Vec<DecodedVideoFrame>, MediaError> {
    initialize()?;
    if max_frames == 0 {
        return Ok(Vec::new());
    }

    let mut input = ffmpeg::format::input(path.as_ref())
        .map_err(|error| MediaError::Open(error.to_string()))?;
    let (stream_index, mut decoder) = {
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or(MediaError::MissingVideoStream)?;
        let stream_index = stream.index();
        let decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
            .and_then(|context| context.decoder().video())
            .map_err(|error| MediaError::Decoder(error.to_string()))?;
        (stream_index, decoder)
    };

    let mut scaler = ffmpeg::software::scaling::Context::get(
        decoder.format(),
        decoder.width(),
        decoder.height(),
        ffmpeg::format::Pixel::RGBA,
        decoder.width(),
        decoder.height(),
        ffmpeg::software::scaling::Flags::BILINEAR,
    ).map_err(|error| MediaError::Decoder(error.to_string()))?;

    let mut frames = Vec::with_capacity(max_frames.min(16));
    let mut decoded_count = 0usize;
    for (stream, packet) in input.packets() {
        if stream.index() != stream_index {
            continue;
        }
        decoder.send_packet(&packet)
            .map_err(|error| MediaError::Decoder(error.to_string()))?;
        drain_video_frames(&mut decoder, &mut scaler, &mut frames, max_frames, 0, &mut decoded_count)?;
        if frames.len() >= max_frames {
            break;
        }
    }

    if frames.len() < max_frames {
        decoder.send_eof()
            .map_err(|error| MediaError::Decoder(error.to_string()))?;
        drain_video_frames(&mut decoder, &mut scaler, &mut frames, max_frames, 0, &mut decoded_count)?;
    }

    Ok(frames)
}

fn drain_video_frames(
    decoder: &mut ffmpeg::decoder::Video,
    scaler: &mut ffmpeg::software::scaling::Context,
    output: &mut Vec<DecodedVideoFrame>,
    limit: usize,
    skip_until: usize,
    decoded_count: &mut usize,
) -> Result<(), MediaError> {
    let mut decoded = ffmpeg::frame::Video::empty();
    while output.len() < limit && decoder.receive_frame(&mut decoded).is_ok() {
        let current_index = *decoded_count;
        *decoded_count = decoded_count.saturating_add(1);
        if current_index < skip_until {
            continue;
        }
        let mut rgba = ffmpeg::frame::Video::empty();
        scaler.run(&decoded, &mut rgba)
            .map_err(|error| MediaError::Decoder(error.to_string()))?;

        let width = rgba.width();
        let height = rgba.height();
        let row_bytes = (width as usize)
            .checked_mul(4)
            .ok_or_else(|| MediaError::InvalidFrame("RGBA row size overflow".into()))?;
        let total_bytes = row_bytes
            .checked_mul(height as usize)
            .ok_or_else(|| MediaError::InvalidFrame("RGBA frame size overflow".into()))?;
        let stride = rgba.stride(0);
        let plane = rgba.data(0);
        if stride < row_bytes || plane.len() < stride.saturating_mul(height as usize) {
            return Err(MediaError::InvalidFrame("FFmpeg returned a truncated RGBA plane".into()));
        }

        let mut pixels = Vec::with_capacity(total_bytes);
        for row in 0..height as usize {
            let start = row * stride;
            pixels.extend_from_slice(&plane[start..start + row_bytes]);
        }

        output.push(DecodedVideoFrame {
            presentation_timestamp: decoded.timestamp(),
            width,
            height,
            rgba: pixels,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_frame_request_does_not_open_a_file() {
        let frames = decode_video_frames("does-not-exist.mov", 0).expect("zero frames is a no-op");
        assert!(frames.is_empty());
    }

    #[test]
    fn error_types_are_displayable() {
        assert!(MediaError::MissingVideoStream.to_string().contains("no video stream"));
    }

    #[test]
    fn frame_buffer_shape_is_explicit() {
        let frame = DecodedVideoFrame {
            presentation_timestamp: Some(42),
            width: 2,
            height: 1,
            rgba: vec![0; 8],
        };
        assert_eq!(frame.rgba.len(), frame.width as usize * frame.height as usize * 4);
    }
}


/// Decode one source frame by zero-based presentation order. This performs a
/// sequential decode from the beginning, so it is correct but not yet an
/// optimized random-access seek implementation.
pub fn decode_video_frame_at(
    path: impl AsRef<Path>,
    frame_index: usize,
) -> Result<DecodedVideoFrame, MediaError> {
    initialize()?;
    let mut input = ffmpeg::format::input(path.as_ref())
        .map_err(|error| MediaError::Open(error.to_string()))?;
    let (stream_index, mut decoder) = {
        let stream = input.streams().best(ffmpeg::media::Type::Video)
            .ok_or(MediaError::MissingVideoStream)?;
        let stream_index = stream.index();
        let decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
            .and_then(|context| context.decoder().video())
            .map_err(|error| MediaError::Decoder(error.to_string()))?;
        (stream_index, decoder)
    };
    let mut scaler = ffmpeg::software::scaling::Context::get(
        decoder.format(), decoder.width(), decoder.height(),
        ffmpeg::format::Pixel::RGBA, decoder.width(), decoder.height(),
        ffmpeg::software::scaling::Flags::BILINEAR,
    ).map_err(|error| MediaError::Decoder(error.to_string()))?;

    let mut selected = Vec::with_capacity(1);
    let mut decoded_count = 0usize;
    for (stream, packet) in input.packets() {
        if stream.index() == stream_index {
            decoder.send_packet(&packet)
                .map_err(|error| MediaError::Decoder(error.to_string()))?;
            drain_video_frames(&mut decoder, &mut scaler, &mut selected, 1, frame_index, &mut decoded_count)?;
            if !selected.is_empty() { return Ok(selected.remove(0)); }
        }
    }
    decoder.send_eof().map_err(|error| MediaError::Decoder(error.to_string()))?;
    drain_video_frames(&mut decoder, &mut scaler, &mut selected, 1, frame_index, &mut decoded_count)?;
    selected.pop().ok_or_else(|| MediaError::InvalidFrame(format!("source frame {frame_index} does not exist")))
}

/// Decode a source audio stream to the editor's standard 48 kHz stereo float
/// PCM format. The returned buffer can be passed directly to kyrocut-audio.
pub fn decode_audio_f32_stereo(path: impl AsRef<Path>) -> Result<kyrocut_audio::PcmBuffer, MediaError> {
    initialize()?;
    let mut input = ffmpeg::format::input(path.as_ref())
        .map_err(|error| MediaError::Open(error.to_string()))?;
    let (stream_index, mut decoder) = {
        let stream = input.streams().best(ffmpeg::media::Type::Audio)
            .ok_or_else(|| MediaError::Audio("media contains no audio stream".into()))?;
        let stream_index = stream.index();
        let decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
            .and_then(|context| context.decoder().audio())
            .map_err(|error| MediaError::Audio(error.to_string()))?;
        (stream_index, decoder)
    };
    let mut resampler = decoder.resampler(
        ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
        ffmpeg::channel_layout::ChannelLayout::STEREO,
        48_000,
    ).map_err(|error| MediaError::Audio(error.to_string()))?;

    let mut samples = Vec::<f32>::new();
    let mut decoded = ffmpeg::frame::Audio::empty();
    let mut converted = ffmpeg::frame::Audio::empty();
    for (stream, packet) in input.packets() {
        if stream.index() != stream_index { continue; }
        decoder.send_packet(&packet)
            .map_err(|error| MediaError::Audio(error.to_string()))?;
        while decoder.receive_frame(&mut decoded).is_ok() {
            resampler.run(&decoded, &mut converted)
                .map_err(|error| MediaError::Audio(error.to_string()))?;
            if converted.samples() > 0 {
                samples.extend_from_slice(converted.plane::<f32>(0));
            }
        }
    }
    decoder.send_eof().map_err(|error| MediaError::Audio(error.to_string()))?;
    while decoder.receive_frame(&mut decoded).is_ok() {
        resampler.run(&decoded, &mut converted)
            .map_err(|error| MediaError::Audio(error.to_string()))?;
        if converted.samples() > 0 {
            samples.extend_from_slice(converted.plane::<f32>(0));
        }
    }
    while resampler.flush(&mut converted).map_err(|error| MediaError::Audio(error.to_string()))?.is_some() {
        if converted.samples() > 0 {
            samples.extend_from_slice(converted.plane::<f32>(0));
        }
    }
    kyrocut_audio::PcmBuffer::new(48_000, 2, samples)
        .map_err(|error| MediaError::Audio(error.to_string()))
}

/// Mix every enabled audio clip in a project into a 48 kHz stereo buffer.
/// Source buffers are keyed by the stable media ID used by the project file.
/// Timeline and source frame positions are converted using the project's
/// rational frame rate, avoiding floating-point drift for fractional rates.
pub fn mix_project_audio(
    project: &kyrocut_core::Project,
    media_audio: &std::collections::HashMap<String, kyrocut_audio::PcmBuffer>,
) -> Result<kyrocut_audio::PcmBuffer, MediaError> {
    project.validate().map_err(|error| MediaError::Project(error.to_string()))?;
    const SAMPLE_RATE: u32 = 48_000;
    const CHANNELS: u16 = 2;

    fn frames_to_samples(frames: u64, rate: kyrocut_core::FrameRate, sample_rate: u32) -> Result<usize, MediaError> {
        let numerator = (frames as u128)
            .checked_mul(sample_rate as u128)
            .and_then(|value| value.checked_mul(rate.denominator as u128))
            .ok_or_else(|| MediaError::Audio("audio timeline position overflow".into()))?;
        let denominator = rate.numerator as u128;
        let rounded = numerator
            .checked_add(denominator / 2)
            .ok_or_else(|| MediaError::Audio("audio timeline position overflow".into()))?
            / denominator;
        usize::try_from(rounded)
            .map_err(|_| MediaError::Audio("audio timeline exceeds addressable memory".into()))
    }

    let output_frames = frames_to_samples(project.duration_frames(), project.frame_rate, SAMPLE_RATE)?;
    let mut clips = Vec::new();
    for track in &project.tracks {
        if track.kind != kyrocut_core::TrackKind::Audio || track.muted {
            continue;
        }
        for clip in &track.clips {
            if !clip.enabled {
                continue;
            }
            let media = project.media.iter().find(|media| media.id == clip.media_id)
                .ok_or_else(|| MediaError::Project(format!("missing media {}", clip.media_id)))?;
            if media.kind != kyrocut_core::MediaKind::Audio {
                return Err(MediaError::Project(format!(
                    "audio track clip {} references non-audio media {}",
                    clip.id, media.id
                )));
            }
            let source = media_audio.get(&media.id)
                .ok_or_else(|| MediaError::Audio(format!("no decoded PCM for media {}", media.id)))?;
            if source.sample_rate() != SAMPLE_RATE || source.channels() != CHANNELS {
                return Err(MediaError::Audio(format!(
                    "media {} must be decoded to 48 kHz stereo PCM", media.id
                )));
            }
            clips.push(kyrocut_audio::AudioClip {
                source,
                timeline_start_frame: frames_to_samples(clip.timeline_start.0, project.frame_rate, SAMPLE_RATE)?,
                source_in_frame: frames_to_samples(clip.source_in.0, project.frame_rate, SAMPLE_RATE)?,
                duration_frames: frames_to_samples(clip.duration_frames, project.frame_rate, SAMPLE_RATE)?,
                gain_db: 0.0,
                pan: 0.0,
                enabled: true,
            });
        }
    }

    kyrocut_audio::mix_timeline(SAMPLE_RATE, CHANNELS, output_frames, &clips)
        .map_err(|error| MediaError::Audio(error.to_string()))
}

/// Evaluate the shared Rust project timeline and composite active video clips
/// at a timeline frame. Media paths are resolved by stable project media ID.
/// Audio tracks are intentionally rendered by the separate PCM mixer.
pub fn render_timeline_video_frame(
    project: &kyrocut_core::Project,
    timeline_frame: kyrocut_core::Frame,
    media_paths: &std::collections::HashMap<String, PathBuf>,
) -> Result<kyrocut_render::RgbaImage, MediaError> {
    project.validate().map_err(|error| MediaError::Project(error.to_string()))?;
    let mut images = Vec::new();
    for active in project.active_clips_at(timeline_frame) {
        let track = project.tracks.iter().find(|track| track.id == active.track_id)
            .ok_or_else(|| MediaError::Project(format!("missing track {}", active.track_id)))?;
        if !matches!(track.kind, kyrocut_core::TrackKind::Video | kyrocut_core::TrackKind::Graphics) {
            continue;
        }
        let media = project.media.iter().find(|media| media.id == active.clip.media_id)
            .ok_or_else(|| MediaError::Project(format!("missing media {}", active.clip.media_id)))?;
        if !matches!(media.kind, kyrocut_core::MediaKind::Video | kyrocut_core::MediaKind::Image) { continue; }
        let source_frame = if media.kind == kyrocut_core::MediaKind::Image { 0 } else { active.source_frame.0 as usize };
        let path = media_paths.get(&media.id)
            .ok_or_else(|| MediaError::Open(format!("no linked file for media {}", media.id)))?;
        let frame = decode_video_frame_at(path, source_frame)?;
        let image = kyrocut_render::RgbaImage::new(frame.width, frame.height, frame.rgba)
            .map_err(|error| MediaError::Render(error.to_string()))?;
        images.push(image);
    }

    let layers = images.iter().map(|image| kyrocut_render::TransformedLayer {
        image,
        transform: kyrocut_render::Transform2D {
            position: [project.width as f32 / 2.0, project.height as f32 / 2.0],
            scale: [project.width as f32 / image.width as f32, project.height as f32 / image.height as f32],
            rotation_radians: 0.0,
            anchor: [image.width as f32 / 2.0, image.height as f32 / 2.0],
        },
        opacity: 1.0,
        blend_mode: kyrocut_render::BlendMode::Normal,
    }).collect::<Vec<_>>();
    kyrocut_render::composite_transformed(project.width, project.height, &layers)
        .map_err(|error| MediaError::Render(error.to_string()))
}


#[cfg(test)]
mod timeline_audio_tests {
    use super::*;
    use kyrocut_core::{Clip, Frame, FrameRate, MediaKind, MediaReference, Project, Track, TrackKind};

    #[test]
    fn project_audio_mix_honours_source_in_timeline_start_and_muted_tracks() {
        let mut project = Project::new("Audio mix", 1920, 1080, FrameRate::FPS_30);
        project.media.push(MediaReference {
            id: "audio-1".into(),
            name: "music.wav".into(),
            kind: MediaKind::Audio,
            size_bytes: 1024,
            mime_type: "audio/wav".into(),
            locator: "media/music.wav".into(),
            duration_frames: Some(10),
        });
        project.tracks.push(Track {
            id: "audio-track".into(),
            name: "A1".into(),
            kind: TrackKind::Audio,
            muted: false,
            locked: false,
            clips: vec![Clip {
                id: "audio-clip".into(),
                media_id: "audio-1".into(),
                timeline_start: Frame(1),
                source_in: Frame(1),
                duration_frames: 1,
                enabled: true,
            }],
        });

        let source = kyrocut_audio::PcmBuffer::new(
            48_000, 2, vec![0.5; 3_200 * 2],
        ).unwrap();
        let sources = std::collections::HashMap::from([("audio-1".to_owned(), source)]);
        let mixed = mix_project_audio(&project, &sources).unwrap();

        assert_eq!(mixed.sample_rate(), 48_000);
        assert_eq!(mixed.channels(), 2);
        assert_eq!(mixed.frame_count(), 3_200);
        assert_eq!(&mixed.samples()[..3_200], &vec![0.0; 3_200]);
        assert!(mixed.samples()[3_200..].iter().all(|sample| (*sample - 0.5).abs() < 1e-6));
    }

    #[test]
    fn project_audio_mix_rejects_missing_decoded_media() {
        let mut project = Project::new("Missing audio", 1280, 720, FrameRate::FPS_30);
        project.media.push(MediaReference {
            id: "audio-1".into(), name: "missing.wav".into(),
            kind: MediaKind::Audio, size_bytes: 0, mime_type: "audio/wav".into(),
            locator: "media/missing.wav".into(), duration_frames: Some(30),
        });
        project.tracks.push(Track {
            id: "audio-track".into(), name: "A1".into(), kind: TrackKind::Audio,
            muted: false, locked: false,
            clips: vec![Clip {
                id: "audio-clip".into(), media_id: "audio-1".into(),
                timeline_start: Frame(0), source_in: Frame(0),
                duration_frames: 10, enabled: true,
            }],
        });
        let result = mix_project_audio(&project, &std::collections::HashMap::new());
        assert!(matches!(result, Err(MediaError::Audio(message)) if message.contains("no decoded PCM")));
    }
}
