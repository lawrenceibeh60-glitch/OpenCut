import { describe, expect, it } from 'vitest'
import { clampTimelineTime, getActivePlaybackClips, getPrimaryPreviewClip } from './timeline-playback'

const tracks = [
  { id: 'v1', kind: 'video' as const, muted: false, clips: [{ id: 'bottom', mediaId: 'a', start: 0, duration: 5, enabled: true }] },
  { id: 'v2', kind: 'video' as const, muted: false, clips: [{ id: 'top', mediaId: 'b', start: 1, duration: 2, enabled: true }] },
  { id: 'a1', kind: 'audio' as const, muted: false, clips: [{ id: 'sound', mediaId: 'c', start: 0, duration: 5, enabled: true }] },
]

describe('timeline playback resolution', () => {
  it('returns all clips active at the requested time in top-to-bottom order', () => {
    expect(getActivePlaybackClips(tracks, 1.5).map(({ clip }) => clip.id))
      .toEqual(['top', 'bottom', 'sound'])
  })
  it('uses the highest visual track as the preview source', () => {
    const active = getActivePlaybackClips(tracks, 1.5)
    expect(getPrimaryPreviewClip(active)?.clip.id).toBe('top')
  })
  it('falls back to audio when no visual clip is active', () => {
    const audioOnly = [{ id: 'a1', kind: 'audio' as const, muted: false, clips: tracks[2].clips }]
    expect(getPrimaryPreviewClip(getActivePlaybackClips(audioOnly, 2))?.clip.id).toBe('sound')
  })
  it('excludes muted tracks, disabled clips and end-exclusive boundaries', () => {
    const muted = [{ ...tracks[0], muted: true }, { ...tracks[1], clips: [{ ...tracks[1].clips[0], enabled: false }] }]
    expect(getActivePlaybackClips(muted, 1.5)).toEqual([])
    expect(getActivePlaybackClips(tracks, 5)).toEqual([])
  })
  it('rejects invalid time and clamps the playhead', () => {
    expect(getActivePlaybackClips(tracks, Number.NaN)).toEqual([])
    expect(clampTimelineTime(-1, 10)).toBe(0)
    expect(clampTimelineTime(12, 10)).toBe(10)
    expect(clampTimelineTime(Number.NaN, 10)).toBe(0)
  })
})

  it('handles a one-frame clip and excludes malformed durations', () => {
    const single = [{ id: 'v1', kind: 'video' as const, muted: false, clips: [
      { id: 'one-frame', mediaId: 'a', start: 2, duration: 1 / 30, enabled: true },
      { id: 'invalid', mediaId: 'b', start: 2, duration: 0, enabled: true },
    ] }]
    expect(getActivePlaybackClips(single, 2).map(({ clip }) => clip.id)).toEqual(['one-frame'])
    expect(getActivePlaybackClips(single, 2 + 1 / 30)).toEqual([])
  })
