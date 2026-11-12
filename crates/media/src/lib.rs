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
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Initialization(message) => write!(formatter, "FFmpeg initialization failed: {message}"),
            Self::Open(message) => write!(formatter, "could not open media: {message}"),
            Self::MissingVideoStream => write!(formatter, "media contains no video stream"),
            Self::Decoder(message) => write!(formatter, "video decoder failed: {message}"),
            Self::InvalidFrame(message) => write!(formatter, "invalid decoded frame: {message}"),
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
    let duration_seconds = (duration > 0).then_some(duration as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE));

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
    for (stream, packet) in input.packets() {
        if stream.index() != stream_index {
            continue;
        }
        decoder.send_packet(&packet)
            .map_err(|error| MediaError::Decoder(error.to_string()))?;
        drain_video_frames(&mut decoder, &mut scaler, &mut frames, max_frames)?;
        if frames.len() >= max_frames {
            break;
        }
    }

    if frames.len() < max_frames {
        decoder.send_eof()
            .map_err(|error| MediaError::Decoder(error.to_string()))?;
        drain_video_frames(&mut decoder, &mut scaler, &mut frames, max_frames)?;
    }

    Ok(frames)
}

fn drain_video_frames(
    decoder: &mut ffmpeg::decoder::Video,
    scaler: &mut ffmpeg::software::scaling::Context,
    output: &mut Vec<DecodedVideoFrame>,
    limit: usize,
) -> Result<(), MediaError> {
    let mut decoded = ffmpeg::frame::Video::empty();
    while output.len() < limit && decoder.receive_frame(&mut decoded).is_ok() {
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
