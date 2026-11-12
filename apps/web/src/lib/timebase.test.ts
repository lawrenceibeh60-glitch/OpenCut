import { describe, expect, it } from 'vitest'
import { framesToSeconds, secondsToFrames } from './timebase'

describe('rational timeline timebase', () => {
  it('converts seconds to 30 fps frame positions', () => {
    expect(secondsToFrames(10)).toBe(300)
  })

  it('converts frame positions back to seconds', () => {
    expect(framesToSeconds(300)).toBe(10)
  })

  it('supports fractional frame rates without using a rounded fps value', () => {
    const rate = { numerator: 30_000, denominator: 1_001 }
    expect(framesToSeconds(30, rate)).toBeCloseTo(1.001)
    expect(secondsToFrames(1.001, rate)).toBe(30)
  })

  it('rejects invalid frame rates', () => {
    expect(() => secondsToFrames(1, { numerator: 0, denominator: 1 })).toThrow(RangeError)
    expect(() => framesToSeconds(1, { numerator: 30, denominator: 0 })).toThrow(RangeError)
  })

  it('rejects negative and non-finite time values', () => {
    expect(() => secondsToFrames(-1)).toThrow(RangeError)
    expect(() => secondsToFrames(Number.NaN)).toThrow(RangeError)
    expect(() => framesToSeconds(-1)).toThrow(RangeError)
  })
})
