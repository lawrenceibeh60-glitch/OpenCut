import { describe, expect, it } from 'vitest'
import { applyClipTrim } from './timeline-editing'

const rate = { numerator: 30, denominator: 1 }

describe('timeline clip trimming', () => {
  it('trims the right edge in whole frames', () => {
    expect(applyClipTrim({ start: 2, sourceIn: 1, duration: 4 }, 'right', 15, rate))
      .toEqual({ start: 2, sourceIn: 1, duration: 4.5 })
  })
  it('does not extend beyond known source media', () => {
    expect(applyClipTrim({ start: 0, sourceIn: 8, duration: 2 }, 'right', 90, rate, 10))
      .toEqual({ start: 0, sourceIn: 8, duration: 2 })
  })
  it('trims the left edge while preserving the original end', () => {
    expect(applyClipTrim({ start: 4, sourceIn: 2, duration: 5 }, 'left', 30, rate))
      .toEqual({ start: 5, sourceIn: 3, duration: 4 })
  })
  it('prevents left trim from crossing timeline zero or source zero', () => {
    expect(applyClipTrim({ start: 0, sourceIn: 0, duration: 2 }, 'left', -60, rate))
      .toEqual({ start: 0, sourceIn: 0, duration: 2 })
  })
  it('keeps at least one frame after a trim', () => {
    expect(applyClipTrim({ start: 1, sourceIn: 1, duration: 1 / 30 }, 'right', -20, rate))
      .toEqual({ start: 1, sourceIn: 1, duration: 1 / 30 })
  })
})
