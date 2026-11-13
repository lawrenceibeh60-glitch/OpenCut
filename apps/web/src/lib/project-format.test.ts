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


  it('round-trips bounded non-destructive clip effects', () => {
    const withEffects = {
      ...validProject,
      tracks: [{
        ...validProject.tracks[0],
        clips: [{
          ...validProject.tracks[0].clips[0],
          effects: { blendMode: 'screen', brightness: 125, contrast: 90, saturation: 140, blur: 2.5, grayscale: 0, sepia: 15, hueRotate: 210, opacity: 80, positionX: 12, positionY: -8, scaleX: 1.5, scaleY: 0.75, rotation: 45 },
          keyframes: [
            { frame: 0, property: 'positionX', value: 0, interpolation: 'linear' },
            { frame: 30, property: 'positionX', value: 25, interpolation: 'hold' },
          ],
        }],
      }],
    }
    const parsed = parseProjectManifest(JSON.stringify(withEffects))
    expect(parsed.tracks[0].clips[0].effects).toEqual(withEffects.tracks[0].clips[0].effects)
    expect(parsed.tracks[0].clips[0].keyframes).toEqual(withEffects.tracks[0].clips[0].keyframes)
  })

  it('fills transform defaults when opening older projects with legacy effect fields', () => {
    const legacy = {
      ...validProject,
      tracks: [{
        ...validProject.tracks[0],
        clips: [{
          ...validProject.tracks[0].clips[0],
          effects: { brightness: 100, contrast: 100, saturation: 100, blur: 0, grayscale: 0, sepia: 0, hueRotate: 0, opacity: 100 },
        }],
      }],
    }
    const parsed = parseProjectManifest(JSON.stringify(legacy))
    expect(parsed.tracks[0].clips[0].effects).toMatchObject({
      positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, rotation: 0,
    })
  })

  it('rejects out-of-range clip effect values', () => {
    const invalid = {
      ...validProject,
      tracks: [{
        ...validProject.tracks[0],
        clips: [{ ...validProject.tracks[0].clips[0], effects: { brightness: 250 } }],
      }],
    }
    expect(() => parseProjectManifest(JSON.stringify(invalid))).toThrow('Effect brightness')
  })

  it('rejects duplicate keyframes for the same property and frame', () => {
    const invalid = {
      ...validProject,
      tracks: [{
        ...validProject.tracks[0],
        clips: [{
          ...validProject.tracks[0].clips[0],
          keyframes: [
            { frame: 12, property: 'rotation', value: 10, interpolation: 'linear' },
            { frame: 12, property: 'rotation', value: 20, interpolation: 'hold' },
          ],
        }],
      }],
    }
    expect(() => parseProjectManifest(JSON.stringify(invalid))).toThrow('Duplicate keyframe')
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
