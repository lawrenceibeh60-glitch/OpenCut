import { describe, expect, it } from 'vitest'
import { evaluateClipEffects, evaluateKeyframes } from './clip-animation'
import type { ClipEffects, ClipKeyframe } from './project-format'

const base: ClipEffects = {
  volume: 100, brightness: 100, contrast: 100, saturation: 100, blur: 0, grayscale: 0,
  sepia: 0, hueRotate: 0, opacity: 100,
  positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, rotation: 0,
}
const keys: ClipKeyframe[] = [
  { frame: 0, property: 'positionX', value: 0, interpolation: 'linear' },
  { frame: 30, property: 'positionX', value: 60, interpolation: 'linear' },
  { frame: 0, property: 'opacity', value: 0, interpolation: 'hold' },
  { frame: 30, property: 'opacity', value: 100, interpolation: 'linear' },
  { frame: 0, property: 'volume', value: 100, interpolation: 'linear' },
  { frame: 30, property: 'volume', value: 0, interpolation: 'linear' },
  { frame: 0, property: 'brightness', value: 100, interpolation: 'linear' },
  { frame: 30, property: 'brightness', value: 200, interpolation: 'linear' },
]

describe('clip keyframe evaluation', () => {
  it('linearly interpolates a property between frames', () => {
    expect(evaluateKeyframes(0, keys, 'positionX', 15)).toBe(30)
  })
  it('holds the left key value until the next keyframe', () => {
    expect(evaluateKeyframes(100, keys, 'opacity', 15)).toBe(0)
    expect(evaluateKeyframes(100, keys, 'opacity', 30)).toBe(100)
  })
  it('holds endpoint values outside the keyed range', () => {
    expect(evaluateKeyframes(0, keys, 'positionX', -10)).toBe(0)
    expect(evaluateKeyframes(0, keys, 'positionX', 90)).toBe(60)
  })
  it('evaluates multiple transform and opacity properties together', () => {
    expect(evaluateClipEffects(base, keys, 15)).toMatchObject({ positionX: 30, opacity: 0, volume: 50, brightness: 150 })
  })
  it('returns the base effect value when no keys exist', () => {
    expect(evaluateKeyframes(12, [], 'rotation', 10)).toBe(12)
  })
})
