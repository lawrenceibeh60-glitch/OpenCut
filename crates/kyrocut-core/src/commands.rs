//! Transactional edit operations shared by desktop and web clients.

use crate::{Clip, Frame, MediaReference, Project, ProjectError, Track};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditCommand {
    MoveClip { clip_id: String, timeline_start: Frame },
    TrimClip { clip_id: String, source_in: Frame, duration_frames: u64 },
    SetClipEnabled { clip_id: String, enabled: bool },
    InsertClip { track_id: String, clip: Clip },
    RemoveClip { clip_id: String },
    AddTrack { track: Track },
    RemoveTrack { track_id: String },
    SetTrackMuted { track_id: String, muted: bool },
    SetTrackLocked { track_id: String, locked: bool },
    AddMedia { media: MediaReference },
    RemoveMedia { media_id: String },
}

impl Project {
    /// Apply an edit atomically. Invalid edits leave the project unchanged.
    pub fn apply_edit(&mut self, command: EditCommand) -> Result<(), ProjectError> {
        let before = self.clone();
        let result = self.apply_edit_inner(command).and_then(|()| self.validate());
        if result.is_err() {
            *self = before;
        }
        result
    }

    fn apply_edit_inner(&mut self, command: EditCommand) -> Result<(), ProjectError> {
        match command {
            EditCommand::MoveClip { clip_id, timeline_start } => {
                let clip = self.find_clip_mut(&clip_id)?;
                clip.timeline_start = timeline_start;
            }
            EditCommand::TrimClip { clip_id, source_in, duration_frames } => {
                let clip = self.find_clip_mut(&clip_id)?;
                clip.source_in = source_in;
                clip.duration_frames = duration_frames;
            }
            EditCommand::SetClipEnabled { clip_id, enabled } => {
                self.find_clip_mut(&clip_id)?.enabled = enabled;
            }
            EditCommand::InsertClip { track_id, clip } => {
                self.find_track_mut(&track_id)?.clips.push(clip);
            }
            EditCommand::RemoveClip { clip_id } => {
                let track = self.tracks.iter_mut()
                    .find(|track| track.clips.iter().any(|clip| clip.id == clip_id))
                    .ok_or_else(|| ProjectError::UnknownClip(clip_id.clone()))?;
                let index = track.clips.iter().position(|clip| clip.id == clip_id)
                    .ok_or_else(|| ProjectError::UnknownClip(clip_id.clone()))?;
                track.clips.remove(index);
            }
            EditCommand::AddTrack { track } => self.tracks.push(track),
            EditCommand::RemoveTrack { track_id } => {
                let index = self.tracks.iter().position(|track| track.id == track_id)
                    .ok_or_else(|| ProjectError::UnknownTrack(track_id.clone()))?;
                self.tracks.remove(index);
            }
            EditCommand::SetTrackMuted { track_id, muted } => {
                self.find_track_mut(&track_id)?.muted = muted;
            }
            EditCommand::SetTrackLocked { track_id, locked } => {
                self.find_track_mut(&track_id)?.locked = locked;
            }
            EditCommand::AddMedia { media } => self.media.push(media),
            EditCommand::RemoveMedia { media_id } => {
                let index = self.media.iter().position(|media| media.id == media_id)
                    .ok_or_else(|| ProjectError::UnknownMedia(media_id.clone()))?;
                self.media.remove(index);
            }
        }
        Ok(())
    }

    fn find_clip_mut(&mut self, clip_id: &str) -> Result<&mut Clip, ProjectError> {
        self.tracks.iter_mut()
            .find_map(|track| track.clips.iter_mut().find(|clip| clip.id == clip_id))
            .ok_or_else(|| ProjectError::UnknownClip(clip_id.to_owned()))
    }

    fn find_track_mut(&mut self, track_id: &str) -> Result<&mut Track, ProjectError> {
        self.tracks.iter_mut()
            .find(|track| track.id == track_id)
            .ok_or_else(|| ProjectError::UnknownTrack(track_id.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FrameRate, MediaKind, TrackKind};

    fn project_with_clip() -> Project {
        let mut project = Project::new("Edit test", 1920, 1080, FrameRate::FPS_30);
        project.media.push(MediaReference {
            id: "media-1".into(), name: "source.mp4".into(), kind: MediaKind::Video,
            size_bytes: 1024, mime_type: "video/mp4".into(),
            locator: "media/source.mp4".into(), duration_frames: Some(900),
        });
        project.tracks.push(Track {
            id: "track-1".into(), name: "V1".into(), kind: TrackKind::Video,
            muted: false, locked: false,
            clips: vec![Clip {
                id: "clip-1".into(), media_id: "media-1".into(),
                timeline_start: Frame(0), source_in: Frame(0),
                duration_frames: 120, enabled: true,
            }],
        });
        project
    }

    #[test]
    fn move_clip_changes_timeline_start() {
        let mut project = project_with_clip();
        project.apply_edit(EditCommand::MoveClip {
            clip_id: "clip-1".into(), timeline_start: Frame(45),
        }).unwrap();
        assert_eq!(project.tracks[0].clips[0].timeline_start, Frame(45));
    }

    #[test]
    fn trim_clip_updates_source_and_duration() {
        let mut project = project_with_clip();
        project.apply_edit(EditCommand::TrimClip {
            clip_id: "clip-1".into(), source_in: Frame(15), duration_frames: 90,
        }).unwrap();
        assert_eq!(project.tracks[0].clips[0].source_in, Frame(15));
        assert_eq!(project.tracks[0].clips[0].duration_frames, 90);
    }

    #[test]
    fn invalid_edit_rolls_back() {
        let mut project = project_with_clip();
        let before = project.clone();
        let result = project.apply_edit(EditCommand::TrimClip {
            clip_id: "clip-1".into(), source_in: Frame(0), duration_frames: 0,
        });
        assert_eq!(result, Err(ProjectError::EmptyClip));
        assert_eq!(project, before);
    }

    #[test]
    fn unknown_clip_is_reported() {
        let mut project = project_with_clip();
        assert_eq!(
            project.apply_edit(EditCommand::MoveClip {
                clip_id: "missing".into(), timeline_start: Frame(12),
            }),
            Err(ProjectError::UnknownClip("missing".into()))
        );
    }

    #[test]
    fn clip_insert_and_remove_are_transactional() {
        let mut project = project_with_clip();
        let clip = Clip {
            id: "clip-2".into(), media_id: "media-1".into(),
            timeline_start: Frame(120), source_in: Frame(120),
            duration_frames: 60, enabled: true,
        };
        project.apply_edit(EditCommand::InsertClip { track_id: "track-1".into(), clip }).unwrap();
        assert_eq!(project.tracks[0].clips.len(), 2);
        project.apply_edit(EditCommand::RemoveClip { clip_id: "clip-2".into() }).unwrap();
        assert_eq!(project.tracks[0].clips.len(), 1);
    }

    #[test]
    fn track_state_commands_update_mute_and_lock() {
        let mut project = project_with_clip();
        project.apply_edit(EditCommand::SetTrackMuted { track_id: "track-1".into(), muted: true }).unwrap();
        project.apply_edit(EditCommand::SetTrackLocked { track_id: "track-1".into(), locked: true }).unwrap();
        assert!(project.tracks[0].muted);
        assert!(project.tracks[0].locked);
    }

    #[test]
    fn add_and_remove_track_updates_project_structure() {
        let mut project = project_with_clip();
        project.apply_edit(EditCommand::AddTrack {
            track: Track {
                id: "audio-1".into(), name: "A1".into(), kind: TrackKind::Audio,
                muted: false, locked: false, clips: Vec::new(),
            },
        }).unwrap();
        assert_eq!(project.tracks.len(), 2);
        project.apply_edit(EditCommand::RemoveTrack { track_id: "audio-1".into() }).unwrap();
        assert_eq!(project.tracks.len(), 1);
    }

    #[test]
    fn clip_enabled_command_changes_render_participation() {
        let mut project = project_with_clip();
        project.apply_edit(EditCommand::SetClipEnabled { clip_id: "clip-1".into(), enabled: false }).unwrap();
        assert!(project.active_clips_at(Frame(10)).is_empty());
    }

    #[test]
    fn add_and_remove_unreferenced_media() {
        let mut project = project_with_clip();
        project.apply_edit(EditCommand::AddMedia {
            media: MediaReference {
                id: "media-2".into(), name: "music.wav".into(), kind: crate::MediaKind::Audio,
                size_bytes: 2048, mime_type: "audio/wav".into(),
                locator: "media/music.wav".into(), duration_frames: Some(300),
            },
        }).unwrap();
        assert_eq!(project.media.len(), 2);
        project.apply_edit(EditCommand::RemoveMedia { media_id: "media-2".into() }).unwrap();
        assert_eq!(project.media.len(), 1);
    }

    #[test]
    fn removing_referenced_media_rolls_back() {
        let mut project = project_with_clip();
        let before = project.clone();
        assert_eq!(
            project.apply_edit(EditCommand::RemoveMedia { media_id: "media-1".into() }),
            Err(ProjectError::UnknownMedia("media-1".into()))
        );
        assert_eq!(project, before);
    }
}
