export type PlaybackClip = {
  id: string
  start: number
  duration: number
  enabled: boolean
  mediaId: string
}
export type PlaybackTrack<T extends PlaybackClip = PlaybackClip> = {
  id: string
  kind: 'video' | 'audio' | 'image' | 'graphics' | 'adjustment'
  muted: boolean
  clips: T[]
}
export type ActivePlaybackClip<T extends PlaybackClip = PlaybackClip> = {
  clip: T
  track: PlaybackTrack<T>
  trackIndex: number
}

/** Resolve every enabled clip crossing a timeline time, highest track first. */
export function getActivePlaybackClips<T extends PlaybackClip>(
  tracks: PlaybackTrack<T>[],
  time: number,
): ActivePlaybackClip<T>[] {
  if (!Number.isFinite(time) || time < 0) return []
  return tracks.flatMap((track, trackIndex) => track.muted ? [] : track.clips
    .filter((clip) => clip.enabled && Number.isFinite(clip.start) &&
      Number.isFinite(clip.duration) && clip.duration > 0 &&
      time >= clip.start && time < clip.start + clip.duration)
    .map((clip) => ({ clip, track, trackIndex })))
    .sort((a, b) => b.trackIndex - a.trackIndex)
}

/** Pick the uppermost visual clip, falling back to audio when no visual is active. */
export function getPrimaryPreviewClip<T extends PlaybackClip>(
  active: ActivePlaybackClip<T>[],
): ActivePlaybackClip<T> | null {
  return active.find(({ track }) =>
    track.kind === 'video' || track.kind === 'image' || track.kind === 'graphics',
  ) ?? active.find(({ track }) => track.kind === 'audio') ?? null
}

export function clampTimelineTime(time: number, duration: number): number {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(duration, Math.max(0, time))
}
