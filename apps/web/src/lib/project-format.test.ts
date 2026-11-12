import { describe, expect, it } from 'vitest'
import { parseProjectManifest } from './project-format'

const validProject = {
  format: 'kyrocut-project',
  version: 1,
  application: 'KYROCUT X1',
  name: 'Test sequence',
  frameRate: { numerator: 30, denominator: 1 },
  resolution: { width: 1920, height: 1080 },
  media: [{
    id: 'media-1',
    name: 'shot.mp4',
    kind: 'video',
    size: 1024,
    durationFrames: 300,
    mimeType: 'video/mp4',
    locator: 'media/shot.mp4',
  }],
  tracks: [{
    id: 'video-1',
    name: 'V1',
    kind: 'video',
    muted: false,
    locked: false,
    clips: [{
      id: 'clip-1',
      mediaId: 'media-1',
      timelineStartFrame: 15,
      sourceInFrame: 30,
      durationFrames: 120,
    }],
  }],
  playheadFrame: 45,
}

describe('KYROCUT X1 project manifest', () => {
  it('parses a valid frame-based project', () => {
    const parsed = parseProjectManifest(JSON.stringify(validProject))
    expect(parsed.name).toBe('Test sequence')
    expect(parsed.tracks[0].clips[0].timelineStartFrame).toBe(15)
    expect(parsed.media[0].durationFrames).toBe(300)
  })

  it('preserves disabled clips and accepts unknown media duration from native projects', () => {
    const nativeDocument = {
      ...validProject,
      media: [{ ...validProject.media[0], durationFrames: null }],
      tracks: [{ ...validProject.tracks[0], clips: [{ ...validProject.tracks[0].clips[0], enabled: false }] }],
    }
    const parsed = parseProjectManifest(JSON.stringify(nativeDocument))
    expect(parsed.media[0].durationFrames).toBeNull()
    expect(parsed.tracks[0].clips[0].enabled).toBe(false)
  })

  it('rejects unsupported format versions', () => {
    expect(() => parseProjectManifest(JSON.stringify({ ...validProject, version: 2 }))).toThrow('Unsupported')
  })

  it('rejects clips with unresolved media references', () => {
    const invalid = {
      ...validProject,
      tracks: [{
        ...validProject.tracks[0],
        clips: [{ ...validProject.tracks[0].clips[0], mediaId: 'missing' }],
      }],
    }
    expect(() => parseProjectManifest(JSON.stringify(invalid))).toThrow('missing media')
  })

  it('rejects source ranges outside the referenced media duration', () => {
    const invalid = {
      ...validProject,
      tracks: [{
        ...validProject.tracks[0],
        clips: [{ ...validProject.tracks[0].clips[0], sourceInFrame: 250, durationFrames: 100 }],
      }],
    }
    expect(() => parseProjectManifest(JSON.stringify(invalid))).toThrow('exceeds media duration')
  })

  it('rejects duplicate clip identifiers', () => {
    const invalid = {
      ...validProject,
      tracks: [{
        ...validProject.tracks[0],
        clips: [validProject.tracks[0].clips[0], { ...validProject.tracks[0].clips[0], mediaId: 'media-1' }],
      }],
    }
    expect(() => parseProjectManifest(JSON.stringify(invalid))).toThrow('Duplicate clip ID')
  })

  it('rejects malformed JSON', () => {
    expect(() => parseProjectManifest('{')).toThrow('valid JSON')
  })
})
