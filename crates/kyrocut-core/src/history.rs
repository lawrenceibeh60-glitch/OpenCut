//! Snapshot-backed undo/redo history for deterministic project edits.

use crate::{EditCommand, Project, ProjectError};

#[derive(Debug, Clone)]
pub struct ProjectHistory {
    undo: Vec<Project>,
    redo: Vec<Project>,
    limit: usize,
}

impl Default for ProjectHistory {
    fn default() -> Self {
        Self::new(100)
    }
}

impl ProjectHistory {
    pub fn new(limit: usize) -> Self {
        Self { undo: Vec::new(), redo: Vec::new(), limit: limit.max(1) }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn undo_depth(&self) -> usize {
        self.undo.len()
    }

    pub fn redo_depth(&self) -> usize {
        self.redo.len()
    }

    /// Apply a command and record the previous project only if validation passes.
    pub fn execute(&mut self, project: &mut Project, command: EditCommand) -> Result<(), ProjectError> {
        let mut next = project.clone();
        next.apply_edit(command)?;
        self.undo.push(project.clone());
        if self.undo.len() > self.limit {
            self.undo.remove(0);
        }
        self.redo.clear();
        *project = next;
        Ok(())
    }

    pub fn undo(&mut self, project: &mut Project) -> bool {
        let Some(previous) = self.undo.pop() else { return false };
        self.redo.push(project.clone());
        *project = previous;
        true
    }

    pub fn redo(&mut self, project: &mut Project) -> bool {
        let Some(next) = self.redo.pop() else { return false };
        self.undo.push(project.clone());
        if self.undo.len() > self.limit {
            self.undo.remove(0);
        }
        *project = next;
        true
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Clip, Frame, FrameRate, MediaReference, Track, TrackKind};

    fn project() -> Project {
        let mut project = Project::new("History test", 1280, 720, FrameRate::FPS_30);
        project.media.push(MediaReference {
            id: "media-1".into(), name: "shot.mp4".into(), kind: crate::MediaKind::Video,
            size_bytes: 1024, mime_type: "video/mp4".into(), locator: "media/shot.mp4".into(), duration_frames: Some(300),
        });
        project.tracks.push(Track {
            id: "track-1".into(), name: "V1".into(), kind: TrackKind::Video,
            muted: false, locked: false,
            clips: vec![Clip {
                id: "clip-1".into(), media_id: "media-1".into(),
                timeline_start: Frame(0), source_in: Frame(0),
                duration_frames: 60, enabled: true,
            }],
        });
        project
    }

    #[test]
    fn undo_and_redo_restore_exact_project_states() {
        let mut project = project();
        let original = project.clone();
        let mut history = ProjectHistory::default();

        history.execute(&mut project, EditCommand::MoveClip {
            clip_id: "clip-1".into(), timeline_start: Frame(90),
        }).unwrap();
        assert_eq!(project.tracks[0].clips[0].timeline_start, Frame(90));

        assert!(history.undo(&mut project));
        assert_eq!(project, original);

        assert!(history.redo(&mut project));
        assert_eq!(project.tracks[0].clips[0].timeline_start, Frame(90));
    }

    #[test]
    fn failed_command_does_not_create_history_entry() {
        let mut project = project();
        let mut history = ProjectHistory::default();
        let result = history.execute(&mut project, EditCommand::TrimClip {
            clip_id: "clip-1".into(), source_in: Frame(0), duration_frames: 0,
        });
        assert_eq!(result, Err(ProjectError::EmptyClip));
        assert!(!history.can_undo());
    }

    #[test]
    fn new_edit_clears_redo_branch() {
        let mut project = project();
        let mut history = ProjectHistory::default();
        history.execute(&mut project, EditCommand::MoveClip {
            clip_id: "clip-1".into(), timeline_start: Frame(30),
        }).unwrap();
        assert!(history.undo(&mut project));
        history.execute(&mut project, EditCommand::MoveClip {
            clip_id: "clip-1".into(), timeline_start: Frame(45),
        }).unwrap();
        assert!(!history.can_redo());
    }

    #[test]
    fn history_respects_configured_limit() {
        let mut project = project();
        let mut history = ProjectHistory::new(2);
        for frame in [Frame(10), Frame(20), Frame(30)] {
            history.execute(&mut project, EditCommand::MoveClip {
                clip_id: "clip-1".into(), timeline_start: frame,
            }).unwrap();
        }
        assert_eq!(history.undo_depth(), 2);
    }
}
