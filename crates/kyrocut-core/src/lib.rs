//! Platform-independent project and timeline primitives for KYROCUT X1.
//!
//! Time is represented as integer frames at a rational frame rate. This avoids
//! floating-point drift when editing, seeking, saving, and rendering projects.

use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Serialize};

mod animation;
mod commands;
mod history;

pub use animation::{CurveError, Interpolation, ScalarCurve, ScalarKeyframe};

pub use commands::EditCommand;
pub use history::ProjectHistory;

pub const PROJECT_FORMAT: &str = "kyrocut-project";
pub const PROJECT_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
        numerator.saturating_add(self.numerator as u64 / 2) / self.numerator as u64
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Frame(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
    Graphics,
    Adjustment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaReference {
    pub id: String,
    pub name: String,
    pub kind: MediaKind,
    #[serde(rename = "size")]
    pub size_bytes: u64,
    pub mime_type: String,
    /// Relative path or application-managed asset identifier; never an absolute
    /// machine-specific path in a portable project file.
    pub locator: String,
    pub duration_frames: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub media_id: String,
    #[serde(rename = "timelineStartFrame")]
    pub timeline_start: Frame,
    #[serde(rename = "sourceInFrame")]
    pub source_in: Frame,
    pub duration_frames: u64,
    #[serde(default = "default_clip_enabled")]
    pub enabled: bool,
}

fn default_clip_enabled() -> bool { true }

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub name: String,
    pub kind: TrackKind,
    pub muted: bool,
    pub locked: bool,
    pub clips: Vec<Clip>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActiveClip<'a> {
    pub track_id: &'a str,
    pub clip: &'a Clip,
    pub source_frame: Frame,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
fn default_project_id() -> String { "project-1".to_owned() }
fn default_application_name() -> String { "KYROCUT X1".to_owned() }

pub struct ProjectDocument {
    pub format: String,
    pub version: u32,
    #[serde(default = "default_application_name")]
    pub application: String,
    #[serde(default = "default_project_id")]
    pub id: String,
    pub name: String,
    pub frame_rate: FrameRate,
    pub resolution: Resolution,
    pub media: Vec<MediaReference>,
    pub tracks: Vec<Track>,
    pub playhead_frame: Frame,
}

impl ProjectDocument {
    pub fn from_json(source: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(source)
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    pub fn into_project(self) -> Result<Project, ProjectError> {
        if self.format != PROJECT_FORMAT {
            return Err(ProjectError::UnsupportedProjectFormat);
        }
        if self.version != PROJECT_FORMAT_VERSION {
            return Err(ProjectError::UnsupportedProjectVersion(self.version));
        }
        let project = Project {
            id: self.id,
            name: self.name,
            frame_rate: self.frame_rate,
            width: self.resolution.width,
            height: self.resolution.height,
            tracks: self.tracks,
            media: self.media,
        };
        project.validate()?;
        Ok(project)
    }
}

impl Project {
    /// Create a validated, versioned interchange document from this project.
    pub fn to_document(&self, playhead_frame: Frame) -> Result<ProjectDocument, ProjectError> {
        self.validate()?;
        Ok(ProjectDocument {
            format: PROJECT_FORMAT.to_owned(),
            version: PROJECT_FORMAT_VERSION,
            application: "KYROCUT X1".to_owned(),
            id: self.id.clone(),
            name: self.name.clone(),
            frame_rate: self.frame_rate,
            resolution: Resolution { width: self.width, height: self.height },
            media: self.media.clone(),
            tracks: self.tracks.clone(),
            playhead_frame,
        })
    }


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

        let mut media_ids = HashSet::new();
        for media in &self.media {
            if media.id.trim().is_empty() || media.name.trim().is_empty() || media.locator.trim().is_empty() {
                return Err(ProjectError::EmptyIdentifier);
            }
            if !media_ids.insert(media.id.as_str()) {
                return Err(ProjectError::DuplicateIdentifier(media.id.clone()));
            }
        }

        let mut track_ids = HashSet::new();
        let mut clip_ids = HashSet::new();
        for track in &self.tracks {
            if track.id.trim().is_empty() || track.name.trim().is_empty() {
                return Err(ProjectError::EmptyIdentifier);
            }
            if !track_ids.insert(track.id.as_str()) {
                return Err(ProjectError::DuplicateIdentifier(track.id.clone()));
            }
            for clip in &track.clips {
                clip.validate()?;
                if !clip_ids.insert(clip.id.as_str()) {
                    return Err(ProjectError::DuplicateIdentifier(clip.id.clone()));
                }
                let media = self.media.iter().find(|media| media.id == clip.media_id)
                    .ok_or_else(|| ProjectError::UnknownMedia(clip.media_id.clone()))?;
                if media.duration_frames.is_some_and(|duration| clip.source_out().0 > duration) {
                    return Err(ProjectError::ClipExceedsMedia(clip.id.clone()));
                }
            }
        }
        Ok(())
    }

    /// Evaluate the active clips at a timeline frame without mutating the project.
    pub fn active_clips_at(&self, position: Frame) -> Vec<ActiveClip<'_>> {
        self.tracks.iter().flat_map(|track| {
            track.clips.iter().filter_map(move |clip| {
                let active = clip.enabled
                    && clip.timeline_start.0 <= position.0
                    && position.0 < clip.timeline_end().0;
                active.then_some(ActiveClip {
                    track_id: &track.id,
                    clip,
                    source_frame: Frame(clip.source_in.0.saturating_add(position.0 - clip.timeline_start.0)),
                })
            })
        }).collect()
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
    UnsupportedProjectFormat,
    UnsupportedProjectVersion(u32),
    InvalidDimensions,
    EmptyIdentifier,
    EmptyClip,
    UnknownMedia(String),
    UnknownClip(String),
    ClipExceedsMedia(String),
    DuplicateIdentifier(String),
}

impl fmt::Display for ProjectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFrameRate => write!(f, "frame rate numerator and denominator must be positive"),
            Self::UnsupportedProjectFormat => write!(f, "unsupported project format identifier"),
            Self::UnsupportedProjectVersion(version) => write!(f, "unsupported project format version: {version}"),
            Self::InvalidDimensions => write!(f, "project dimensions must be positive"),
            Self::EmptyIdentifier => write!(f, "project, track, clip, and media identifiers must not be empty"),
            Self::EmptyClip => write!(f, "clip duration must be at least one frame"),
            Self::UnknownMedia(id) => write!(f, "clip references unknown media: {id}"),
            Self::UnknownClip(id) => write!(f, "unknown clip: {id}"),
            Self::ClipExceedsMedia(id) => write!(f, "clip source range exceeds media duration: {id}"),
            Self::DuplicateIdentifier(id) => write!(f, "duplicate project identifier: {id}"),
        }
    }
}

impl std::error::Error for ProjectError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_document_json_round_trips_frame_based_timeline() {
        let mut project = Project::new("Interchange", 1920, 1080, FrameRate::FPS_30);
        project.media.push(MediaReference {
            id: "media-1".into(), name: "take.mp4".into(), kind: MediaKind::Video,
            size_bytes: 4096, mime_type: "video/mp4".into(),
            locator: "media/take.mp4".into(), duration_frames: Some(300),
        });
        project.tracks.push(Track {
            id: "video-1".into(), name: "V1".into(), kind: TrackKind::Video,
            muted: false, locked: false,
            clips: vec![Clip {
                id: "clip-1".into(), media_id: "media-1".into(),
                timeline_start: Frame(15), source_in: Frame(30),
                duration_frames: 120, enabled: true,
            }],
        });
        let document = project.to_document(Frame(48)).unwrap();
        let json = document.to_json().unwrap();
        assert!(json.contains("\\"timelineStartFrame\\": 15"));
        let reopened = ProjectDocument::from_json(&json).unwrap();
        assert_eq!(reopened.playhead_frame, Frame(48));
        assert_eq!(reopened.into_project().unwrap(), project);
    }

    #[test]
    fn project_document_rejects_unsupported_version() {
        let project = Project::new("Version", 1920, 1080, FrameRate::FPS_30);
        let mut document = project.to_document(Frame(0)).unwrap();
        document.version = 99;
        assert_eq!(
            document.into_project(),
            Err(ProjectError::UnsupportedProjectVersion(99))
        );
    }

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
            kind: MediaKind::Video,
            size_bytes: 1024,
            mime_type: "video/mp4".into(),
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
    fn timeline_evaluator_returns_source_frame_for_active_clip() {
        let mut project = Project::new("Evaluate", 1920, 1080, FrameRate::FPS_30);
        project.media.push(MediaReference { id: "m".into(), name: "clip.mp4".into(), kind: MediaKind::Video, size_bytes: 512, mime_type: "video/mp4".into(), locator: "media/clip.mp4".into(), duration_frames: Some(500) });
        project.tracks.push(Track { id: "v1".into(), name: "V1".into(), kind: TrackKind::Video, muted: false, locked: false, clips: vec![Clip { id: "c1".into(), media_id: "m".into(), timeline_start: Frame(100), source_in: Frame(20), duration_frames: 50, enabled: true }] });
        let active = project.active_clips_at(Frame(115));
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].track_id, "v1");
        assert_eq!(active[0].source_frame, Frame(35));
        assert!(project.active_clips_at(Frame(150)).is_empty());
    }

    #[test]
    fn validation_rejects_source_range_beyond_media_duration() {
        let mut project = Project::new("Bounds", 1920, 1080, FrameRate::FPS_30);
        project.media.push(MediaReference { id: "m".into(), name: "short.mp4".into(), kind: MediaKind::Video, size_bytes: 512, mime_type: "video/mp4".into(), locator: "media/short.mp4".into(), duration_frames: Some(20) });
        project.tracks.push(Track { id: "v1".into(), name: "V1".into(), kind: TrackKind::Video, muted: false, locked: false, clips: vec![Clip { id: "c1".into(), media_id: "m".into(), timeline_start: Frame(0), source_in: Frame(10), duration_frames: 15, enabled: true }] });
        assert_eq!(project.validate(), Err(ProjectError::ClipExceedsMedia("c1".into())));
    }

    #[test]
    fn validation_rejects_duplicate_media_identifiers() {
        let mut project = Project::new("Duplicates", 1920, 1080, FrameRate::FPS_30);
        project.media.push(MediaReference { id: "m".into(), name: "one.mp4".into(), kind: MediaKind::Video, size_bytes: 512, mime_type: "video/mp4".into(), locator: "media/one.mp4".into(), duration_frames: None });
        project.media.push(MediaReference { id: "m".into(), name: "two.mp4".into(), kind: MediaKind::Video, size_bytes: 512, mime_type: "video/mp4".into(), locator: "media/two.mp4".into(), duration_frames: None });
        assert_eq!(project.validate(), Err(ProjectError::DuplicateIdentifier("m".into())));
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
