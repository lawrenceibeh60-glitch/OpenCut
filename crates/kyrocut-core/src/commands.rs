//! Transactional edit operations shared by desktop and web clients.

use crate::{Clip, Frame, Project, ProjectError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditCommand {
    MoveClip { clip_id: String, timeline_start: Frame },
    TrimClip { clip_id: String, source_in: Frame, duration_frames: u64 },
    SetClipEnabled { clip_id: String, enabled: bool },
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
        let (clip_id, update): (&str, Box<dyn FnOnce(&mut Clip)>) = match command {
            EditCommand::MoveClip { clip_id, timeline_start } => {
                (Box::leak(clip_id.into_boxed_str()), Box::new(move |clip| clip.timeline_start = timeline_start))
            }
            EditCommand::TrimClip { clip_id, source_in, duration_frames } => {
                (Box::leak(clip_id.into_boxed_str()), Box::new(move |clip| {
                    clip.source_in = source_in;
                    clip.duration_frames = duration_frames;
                }))
            }
            EditCommand::SetClipEnabled { clip_id, enabled } => {
                (Box::leak(clip_id.into_boxed_str()), Box::new(move |clip| clip.enabled = enabled))
            }
        };

        for track in &mut self.tracks {
            if let Some(clip) = track.clips.iter_mut().find(|clip| clip.id == clip_id) {
                update(clip);
                return Ok(());
            }
        }
        Err(ProjectError::UnknownClip(clip_id.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FrameRate, MediaReference, Track, TrackKind};

    fn project_with_clip() -> Project {
        let mut project = Project::new("Edit test", 1920, 1080, FrameRate::FPS_30);
        project.media.push(MediaReference {
            id: "media-1".into(), name: "source.mp4".into(),
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
}
