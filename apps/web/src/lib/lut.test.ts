import { describe, expect, it } from 'vitest'
import { parseCubeLut } from './lut'

describe('parseCubeLut', () => {
  it('parses a 2x2x2 LUT and preserves red-fastest row order', () => {
    const rows = Array.from({ length: 8 }, (_, index) => `${index / 7} 0.25 0.75`).join('\n')
    const lut = parseCubeLut(`TITLE "identity-ish"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n${rows}`, 'test')
    expect(lut.id).toBe('test')
    expect(lut.size).toBe(2)
    expect(lut.data).toHaveLength(32)
    expect(lut.data[0]).toBe(0)
    expect(lut.data[4]).toBeCloseTo(1 / 7)
    expect(lut.data[3]).toBe(1)
  })

  it('rejects missing or malformed LUT data', () => {
    expect(() => parseCubeLut('TITLE "empty"')).toThrow(/LUT_3D_SIZE/)
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0')).toThrow(/expected 8/)
    expect(() => parseCubeLut('LUT_3D_SIZE 1')).toThrow(/from 2 to 64/)
    expect(() => parseCubeLut('LUT_1D_SIZE 16')).toThrow(/1D/)
  })

  it('rejects invalid domains and non-finite values', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 2\nDOMAIN_MIN 1 0 0\nDOMAIN_MAX 1 1 1')).toThrow(/domain minimum/)
    expect(() => parseCubeLut('LUT_3D_SIZE 2\nNaN 0 0')).toThrow(/Unsupported/)
  })
})
