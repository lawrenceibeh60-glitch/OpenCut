import type { RationalFrameRate } from './timebase'

export type ProjectMediaKind = 'video' | 'audio' | 'image' | 'null'
export type ProjectTrackKind = 'video' | 'audio' | 'graphics' | 'adjustment'

export type ClipKeyframe = {
  frame: number
  property: 'opacity' | 'volume' | 'positionX' | 'positionY' | 'scaleX' | 'scaleY' | 'rotation' | 'brightness' | 'contrast' | 'saturation' | 'blur' | 'grayscale' | 'sepia' | 'hueRotate'
  value: number
  interpolation: 'linear' | 'hold'
}

export type ClipEffects = {
  volume: number
  blendMode: 'normal' | 'multiply' | 'screen' | 'add'
  brightness: number
  contrast: number
  saturation: number
  blur: number
  grayscale: number
  sepia: number
  hueRotate: number
  opacity: number
  positionX: number
  positionY: number
  scaleX: number
  scaleY: number
  rotation: number
}

export type ProjectManifest = {
  format: 'kyrocut-project'
  version: 1
  application?: string
  id?: string
  name: string
  frameRate: RationalFrameRate
  resolution: { width: number; height: number }
  media: Array<{
    id: string
    name: string
    kind: ProjectMediaKind
    size: number
    durationFrames: number | null
    mimeType: string
    locator: string
  }>
  tracks: Array<{
    id: string
    name: string
    kind: ProjectTrackKind
    muted: boolean
    locked: boolean
    clips: Array<{
      id: string
      mediaId: string
      timelineStartFrame: number
      sourceInFrame: number
      durationFrames: number
      enabled: boolean
      effects?: ClipEffects
      keyframes?: ClipKeyframe[]
      parentClipId?: string
      lutId?: string
      lutIntensity?: number
    }>
  }>
  playheadFrame: number
}

type RecordValue = Record<string, unknown>

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(label + ' must be an object')
  }
  return value as RecordValue
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(label + ' must be a non-empty string')
  }
  return value
}

function integerValue(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(label + ' must be a safe integer greater than or equal to ' + minimum)
  }
  return value
}

function boundedNumber(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(label + ' must be a finite number between ' + minimum + ' and ' + maximum)
  }
  return value
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(label + ' must be a boolean')
  return value
}

export function parseProjectManifest(source: string): ProjectManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error('Project file is not valid JSON')
  }

  const root = record(parsed, 'Project')
  if (root.format !== 'kyrocut-project' || root.version !== 1) {
    throw new Error('Unsupported KYROCUT X1 project format or version')
  }

  const name = stringValue(root.name, 'Project name')
  const rate = record(root.frameRate, 'Frame rate')
  const frameRate = {
    numerator: integerValue(rate.numerator, 'Frame-rate numerator', 1),
    denominator: integerValue(rate.denominator, 'Frame-rate denominator', 1),
  }
  const resolutionValue = record(root.resolution, 'Resolution')
  const resolution = {
    width: integerValue(resolutionValue.width, 'Resolution width', 1),
    height: integerValue(resolutionValue.height, 'Resolution height', 1),
  }
  if (!Array.isArray(root.media) || !Array.isArray(root.tracks)) {
    throw new Error('Project media and tracks must be arrays')
  }

  const mediaIds = new Set<string>()
  const media = root.media.map((item, index) => {
    const value = record(item, 'Media item ' + index)
    const id = stringValue(value.id, 'Media ID')
    if (mediaIds.has(id)) throw new Error('Duplicate media ID: ' + id)
    mediaIds.add(id)
    const kind = value.kind
    if (kind !== 'video' && kind !== 'audio' && kind !== 'image' && kind !== 'null') {
      throw new Error('Unsupported media kind for ' + id)
    }
    const mediaKind = kind as ProjectMediaKind
    return {
      id,
      name: stringValue(value.name, 'Media name'),
      kind: mediaKind,
      size: integerValue(value.size, 'Media size'),
      durationFrames: value.durationFrames === null || value.durationFrames === undefined ? null : integerValue(value.durationFrames, 'Media duration frames'),
      mimeType: typeof value.mimeType === 'string' ? value.mimeType : '',
      locator: stringValue(value.locator, 'Media locator'),
    }
  })

  const trackIds = new Set<string>()
  const clipIds = new Set<string>()
  const tracks = root.tracks.map((item, index) => {
    const value = record(item, 'Track ' + index)
    const id = stringValue(value.id, 'Track ID')
    if (trackIds.has(id)) throw new Error('Duplicate track ID: ' + id)
    trackIds.add(id)
    const kind = value.kind
    if (kind !== 'video' && kind !== 'audio' && kind !== 'graphics' && kind !== 'adjustment') {
      throw new Error('Unsupported track kind for ' + id)
    }
    const trackKind = kind as ProjectTrackKind
    if (!Array.isArray(value.clips)) throw new Error('Track clips must be an array')
    const clips = value.clips.map((clipValue, clipIndex) => {
      const clip = record(clipValue, 'Clip ' + clipIndex)
      const clipId = stringValue(clip.id, 'Clip ID')
      if (clipIds.has(clipId)) throw new Error('Duplicate clip ID: ' + clipId)
      clipIds.add(clipId)
      const mediaId = stringValue(clip.mediaId, 'Clip media ID')
      const source = media.find((asset) => asset.id === mediaId)
      if (!source) throw new Error('Clip references missing media: ' + mediaId)
      const timelineStartFrame = integerValue(clip.timelineStartFrame, 'Clip timeline start')
      const sourceInFrame = integerValue(clip.sourceInFrame, 'Clip source in')
      const durationFrames = integerValue(clip.durationFrames, 'Clip duration', 1)
      if (source.durationFrames !== null && source.durationFrames > 0 && (durationFrames > source.durationFrames || sourceInFrame > source.durationFrames - durationFrames)) {
        throw new Error('Clip source range exceeds media duration: ' + clipId)
      }
      const effectsValue = clip.effects === undefined ? undefined : record(clip.effects, 'Clip effects')
      const effects: ClipEffects | undefined = effectsValue ? {
        blendMode: effectsValue.blendMode === undefined ? 'normal' : effectsValue.blendMode as ClipEffects['blendMode'],
        brightness: boundedNumber(effectsValue.brightness, 'Effect brightness', 0, 200, 100),
        contrast: boundedNumber(effectsValue.contrast, 'Effect contrast', 0, 200, 100),
        saturation: boundedNumber(effectsValue.saturation, 'Effect saturation', 0, 200, 100),
        blur: boundedNumber(effectsValue.blur, 'Effect blur', 0, 20, 0),
        grayscale: boundedNumber(effectsValue.grayscale, 'Effect grayscale', 0, 100, 0),
        sepia: boundedNumber(effectsValue.sepia, 'Effect sepia', 0, 100, 0),
        hueRotate: boundedNumber(effectsValue.hueRotate, 'Effect hue rotation', 0, 360, 0),
        opacity: boundedNumber(effectsValue.opacity, 'Effect opacity', 0, 100, 100),
        volume: boundedNumber(effectsValue.volume, 'Effect volume', 0, 200, 100),
        positionX: boundedNumber(effectsValue.positionX, 'Effect position X', -100, 100, 0),
        positionY: boundedNumber(effectsValue.positionY, 'Effect position Y', -100, 100, 0),
        scaleX: boundedNumber(effectsValue.scaleX, 'Effect scale X', 0.1, 5, 1),
        scaleY: boundedNumber(effectsValue.scaleY, 'Effect scale Y', 0.1, 5, 1),
        rotation: boundedNumber(effectsValue.rotation, 'Effect rotation', -180, 180, 0),
      } : undefined
      if (effects && !['normal', 'multiply', 'screen', 'add'].includes(effects.blendMode)) throw new Error('Unsupported clip blend mode')
      if (clip.lutIntensity !== undefined && clip.lutId === undefined) throw new Error('LUT intensity requires a LUT ID')
      if (clip.keyframes !== undefined && !Array.isArray(clip.keyframes)) {
        throw new Error('Clip keyframes must be an array')
      }
      const keyframeIdentities = new Set<string>()
      const keyframes: ClipKeyframe[] | undefined = Array.isArray(clip.keyframes)
        ? clip.keyframes.map((keyframeValue, keyframeIndex) => {
          const keyframe = record(keyframeValue, 'Keyframe ' + keyframeIndex)
          const frame = integerValue(keyframe.frame, 'Keyframe frame')
          const property = keyframe.property as ClipKeyframe['property']
          if (property !== 'opacity' && property !== 'volume' && property !== 'positionX' && property !== 'positionY' &&
              property !== 'scaleX' && property !== 'scaleY' && property !== 'rotation' &&
              property !== 'brightness' && property !== 'contrast' && property !== 'saturation' && property !== 'blur' &&
              property !== 'grayscale' && property !== 'sepia' && property !== 'hueRotate') {
            throw new Error('Unsupported keyframe property')
          }
          const bounds: Record<ClipKeyframe['property'], [number, number]> = {
            opacity: [0, 100], volume: [0, 200], positionX: [-100, 100], positionY: [-100, 100],
            scaleX: [0.1, 5], scaleY: [0.1, 5], rotation: [-180, 180],
            brightness: [0, 200], contrast: [0, 200], saturation: [0, 200], blur: [0, 20],
            grayscale: [0, 100], sepia: [0, 100], hueRotate: [0, 360],
          }
          if (typeof keyframe.value !== 'number') throw new Error('Keyframe value must be a number')
          const value = boundedNumber(keyframe.value, 'Keyframe value', bounds[property][0], bounds[property][1], 0)
          const interpolation = (keyframe.interpolation === undefined ? 'linear' : keyframe.interpolation) as ClipKeyframe['interpolation']
          if (interpolation !== 'linear' && interpolation !== 'hold') {
            throw new Error('Unsupported keyframe interpolation')
          }
          const identity = property + ':' + frame
          if (keyframeIdentities.has(identity)) throw new Error('Duplicate keyframe for ' + property + ' at frame ' + frame)
          keyframeIdentities.add(identity)
          return { frame, property, value, interpolation }
        }).sort((a, b) => a.frame - b.frame)
        : undefined
      return {
        id: clipId, mediaId, timelineStartFrame, sourceInFrame, durationFrames,
        enabled: clip.enabled === undefined ? true : booleanValue(clip.enabled, 'Clip enabled state'),
        ...(effects ? { effects } : {}),
        ...(keyframes?.length ? { keyframes } : {}),
        ...(clip.parentClipId === undefined ? {} : { parentClipId: stringValue(clip.parentClipId, 'Parent null-layer ID') }),
        ...(clip.lutId === undefined ? {} : { lutId: stringValue(clip.lutId, 'LUT ID') }),
        ...(clip.lutIntensity === undefined ? {} : { lutIntensity: boundedNumber(clip.lutIntensity, 'LUT intensity', 0, 1, 1) }),
      }
    })
    return {
      id,
      name: stringValue(value.name, 'Track name'),
      kind: trackKind,
      muted: booleanValue(value.muted, 'Track muted state'),
      locked: booleanValue(value.locked, 'Track locked state'),
      clips,
    }
  })

  const clipById = new Map(tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)))
  for (const track of tracks) for (const clip of track.clips) {
    if (!clip.parentClipId) continue
    if (clip.parentClipId === clip.id) throw new Error('A layer cannot parent itself')
    let cursor = clipById.get(clip.parentClipId)
    if (!cursor || media.find((item) => item.id === cursor!.mediaId)?.kind !== 'null') throw new Error('Parent layer must be a null layer: ' + clip.parentClipId)
    const visited = new Set([clip.id])
    while (cursor) {
      if (visited.has(cursor.id)) throw new Error('Null-layer parenting cannot contain cycles')
      visited.add(cursor.id)
      cursor = cursor.parentClipId ? clipById.get(cursor.parentClipId) : undefined
    }
  }

  const manifest: ProjectManifest = {
    format: 'kyrocut-project',
    version: 1,
    ...(typeof root.application === 'string' ? { application: root.application } : {}),
    ...(typeof root.id === 'string' && root.id.trim() ? { id: root.id } : {}),
    name,
    frameRate,
    resolution,
    media,
    tracks,
    playheadFrame: integerValue(root.playheadFrame, 'Project playhead'),
  }
  return manifest
}
