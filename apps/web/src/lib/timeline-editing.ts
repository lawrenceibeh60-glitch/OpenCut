import type { RationalFrameRate } from './timebase'

export type TrimEdge = 'left' | 'right'
export type TrimGeometry = { start: number; sourceIn: number; duration: number }

/** Apply a signed, frame-snapped trim delta while preserving source and timeline bounds. */
export function applyClipTrim(
  original: TrimGeometry,
  edge: TrimEdge,
  deltaFrames: number,
  frameRate: RationalFrameRate,
  sourceDuration?: number,
): TrimGeometry {
  if (!Number.isSafeInteger(deltaFrames)) throw new RangeError('Trim delta must be a safe integer frame count')
  const oneFrame = frameRate.denominator / frameRate.numerator
  const delta = deltaFrames * oneFrame
  if (edge === 'right') {
    const maximum = sourceDuration === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(oneFrame, sourceDuration - original.sourceIn)
    return { ...original, duration: Math.min(maximum, Math.max(oneFrame, original.duration + delta)) }
  }
  const maximumRight = original.duration - oneFrame
  const minimumLeft = Math.max(-original.sourceIn, -original.start)
  const applied = Math.min(maximumRight, Math.max(minimumLeft, delta))
  return {
    start: Math.max(0, original.start + applied),
    sourceIn: Math.max(0, original.sourceIn + applied),
    duration: Math.max(oneFrame, original.duration - applied),
  }
}
