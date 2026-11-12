//! Platform-independent project and timeline primitives for KYROCUT X1.
//!
//! Time is represented as integer frames at a rational frame rate. This avoids
//! floating-point drift when editing, seeking, saving, and rendering projects.

use std::fmt;

pub const PROJECT_FORMAT: &str = "kyrocut-project";
pub const PROJECT_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameRate {
    pub numerator: u32,
    pub denominator: u32,
}

impl FrameRate {
    pub const FPS_24: Self = Self { numerator: 24, denominator: 1 };
    pub const FPS_25: Self = Self { numerator: 25, denominator: 1 };
    pub const FPS_30: Self = Self { numerator: 30, denominator: 1 };
    pub const FPS_60: Self = Self { numerator: 60, denominator: 1 };

    pub fn new(numerator: u32, denominator: u32) -> Result<Self, ProjectError> {
        if numerator == 0 || denominator == 0 {
            return Err(ProjectError::InvalidFrameRate);
        }
        let divisor = gcd(numerator, denominator);
        Ok(Self { numerator: numerator / divisor, denominator: denominator / divisor })
    }

    /// Convert a frame count to a rounded number of milliseconds.
    pub fn frames_to_millis(self, frames: u64) -> u64 {
        let numerator = frames.saturating_mul(1_000)
            .saturating_mul(self.denominator as u64);
        (numerator + (self.numerator as u64 / 2)) / self.numerator as u64
    }

    /// Convert milliseconds to the nearest frame.
    pub fn millis_to_frames(self, millis: u64) -> u64 {
        millis.saturating_mul(self.numerator as u64)
            .saturating_add(500 * self.denominator as u64)
            / (1_000 * self.denominator as u64)
    }
}

fn gcd(mut a: u32, mut b: u32) -> u32 {
    while b != 0 {
        let remainder = a % b;
        a = b;
        b = remainder;
    }
    a.max(1)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Frame(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Video,
    Audio,
    Graphics,
    Adjustment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaReference {
    pub id: String,
    pub name: String,
    /// Relative path or application-managed asset identifier; never an absolute
    /// machine-specific path in a portable project file.
    pub locator: String,
    pub duration_frames: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clip {
    pub id: String,
    pub media_id: String,
    pub timeline_start: Frame,
    pub source_in: Frame,
    pub duration_frames: u64,
    pub enabled: bool,
}

impl Clip {
    pub fn timeline_end(&self) -> Frame {
        Frame(self.timeline_start.0.saturating_add(self.duration_frames))
    }

    pub fn source_out(&self) -> Frame {
        Frame(self.source_in.0.saturating_add(self.duration_frames))
    }

    pub fn validate(&self) -> Result<(), ProjectError> {
        if self.id.trim().is_empty() || self.media_id.trim().is_empty() {
            return Err(ProjectError::EmptyIdentifier);
        }
        if self.duration_frames == 0 {
            return Err(ProjectError::EmptyClip);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Track {
    pub id: String,
    pub name: String,
    pub kind: TrackKind,
    pub muted: bool,
    pub locked: bool,
    pub clips: Vec<Clip>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub frame_rate: FrameRate,
    pub width: u32,
    pub height: u32,
    pub tracks: Vec<Track>,
    pub media: Vec<MediaReference>,
}

impl Project {
    pub fn new(name: impl Into<String>, width: u32, height: u32, frame_rate: FrameRate) -> Self {
        Self {
            id: "project-1".to_owned(),
            name: name.into(),
            frame_rate,
            width,
            height,
            tracks: Vec::new(),
            media: Vec::new(),
        }
    }

    pub fn validate(&self) -> Result<(), ProjectError> {
        if self.id.trim().is_empty() || self.name.trim().is_empty() {
            return Err(ProjectError::EmptyIdentifier);
        }
        if self.width == 0 || self.height == 0 {
            return Err(ProjectError::InvalidDimensions);
        }
        FrameRate::new(self.frame_rate.numerator, self.frame_rate.denominator)?;
        for track in &self.tracks {
            if track.id.trim().is_empty() || track.name.trim().is_empty() {
                return Err(ProjectError::EmptyIdentifier);
            }
            for clip in &track.clips {
                clip.validate()?;
                if !self.media.iter().any(|media| media.id == clip.media_id) {
                    return Err(ProjectError::UnknownMedia(clip.media_id.clone()));
                }
            }
        }
        Ok(())
    }

    pub fn duration_frames(&self) -> u64 {
        self.tracks.iter()
            .flat_map(|track| track.clips.iter())
            .filter(|clip| clip.enabled)
            .map(|clip| clip.timeline_end().0)
            .max()
            .unwrap_or(0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectError {
    InvalidFrameRate,
    InvalidDimensions,
    EmptyIdentifier,
    EmptyClip,
    UnknownMedia(String),
}

impl fmt::Display for ProjectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFrameRate => write!(f, "frame rate numerator and denominator must be positive"),
            Self::InvalidDimensions => write!(f, "project dimensions must be positive"),
            Self::EmptyIdentifier => write!(f, "project, track, clip, and media identifiers must not be empty"),
            Self::EmptyClip => write!(f, "clip duration must be at least one frame"),
            Self::UnknownMedia(id) => write!(f, "clip references unknown media: {id}"),
        }
    }
}

impl std::error::Error for ProjectError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_rate_reduces_fraction() {
        assert_eq!(FrameRate::new(60, 2).unwrap(), FrameRate::FPS_30);
    }

    #[test]
    fn frame_time_conversion_round_trips() {
        let rate = FrameRate::FPS_30;
        assert_eq!(rate.millis_to_frames(rate.frames_to_millis(300)), 300);
    }

    #[test]
    fn project_duration_uses_latest_enabled_clip_end() {
        let mut project = Project::new("Test", 1920, 1080, FrameRate::FPS_30);
        project.media.push(MediaReference {
            id: "media-1".into(),
            name: "shot.mp4".into(),
            locator: "assets/shot.mp4".into(),
            duration_frames: Some(900),
        });
        project.tracks.push(Track {
            id: "video-1".into(),
            name: "V1".into(),
            kind: TrackKind::Video,
            muted: false,
            locked: false,
            clips: vec![
                Clip {
                    id: "clip-1".into(),
                    media_id: "media-1".into(),
                    timeline_start: Frame(45),
                    source_in: Frame(0),
                    duration_frames: 120,
                    enabled: true,
                },
                Clip {
                    id: "clip-2".into(),
                    media_id: "media-1".into(),
                    timeline_start: Frame(200),
                    source_in: Frame(120),
                    duration_frames: 60,
                    enabled: false,
                },
            ],
        });
        assert_eq!(project.duration_frames(), 165);
        assert!(project.validate().is_ok());
    }

    #[test]
    fn validation_rejects_missing_media() {
        let mut project = Project::new("Test", 1920, 1080, FrameRate::FPS_30);
        project.tracks.push(Track {
            id: "video-1".into(),
            name: "V1".into(),
            kind: TrackKind::Video,
            muted: false,
            locked: false,
            clips: vec![Clip {
                id: "clip-1".into(),
                media_id: "missing".into(),
                timeline_start: Frame(0),
                source_in: Frame(0),
                duration_frames: 30,
                enabled: true,
            }],
        });
        assert_eq!(project.validate(), Err(ProjectError::UnknownMedia("missing".into())));
    }
}
