import type { RationalFrameRate } from './timebase'

export type ProjectMediaKind = 'video' | 'audio' | 'image'
export type ProjectTrackKind = 'video' | 'audio' | 'graphics' | 'adjustment'

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
    if (kind !== 'video' && kind !== 'audio' && kind !== 'image') {
      throw new Error('Unsupported media kind for ' + id)
    }
    return {
      id,
      name: stringValue(value.name, 'Media name'),
      kind,
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
      return { id: clipId, mediaId, timelineStartFrame, sourceInFrame, durationFrames, enabled: clip.enabled === undefined ? true : booleanValue(clip.enabled, 'Clip enabled state') }
    })
    return {
      id,
      name: stringValue(value.name, 'Track name'),
      kind,
      muted: booleanValue(value.muted, 'Track muted state'),
      locked: booleanValue(value.locked, 'Track locked state'),
      clips,
    }
  })

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
