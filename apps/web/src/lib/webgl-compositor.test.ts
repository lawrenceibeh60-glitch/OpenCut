import { describe, expect, it } from 'vitest'
import { createLayerTransform } from './webgl-compositor'

const identity = {
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  positionX: 0,
  positionY: 0,
}

describe('WebGL layer transform', () => {
  it('keeps a same-aspect source centered at native scale', () => {
    const matrix = createLayerTransform(1920, 1080, 1920, 1080, identity)
    expect(Array.from(matrix)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  it('fits a wide source inside a square composition without stretching', () => {
    const matrix = createLayerTransform(1000, 1000, 1920, 1080, identity)
    expect(matrix[0]).toBeCloseTo(1)
    expect(matrix[4]).toBeCloseTo(1080 / 1920)
  })

  it('fits a tall source inside a wide composition without stretching', () => {
    const matrix = createLayerTransform(1920, 1080, 1080, 1920, identity)
    expect(matrix[0]).toBeCloseTo((1080 / 1920) / (1920 / 1080))
    expect(matrix[4]).toBeCloseTo(1)
  })

  it('applies independent scale and normalized translation', () => {
    const matrix = createLayerTransform(100, 100, 100, 100, {
      ...identity,
      scaleX: 2,
      scaleY: 0.5,
      positionX: 25,
      positionY: -10,
    })
    expect(matrix[0]).toBeCloseTo(2)
    expect(matrix[4]).toBeCloseTo(0.5)
    expect(matrix[6]).toBeCloseTo(0.5)
    expect(matrix[7]).toBeCloseTo(0.2)
    expect(matrix[8]).toBe(1)
  })

  it('rotates the layer around its center', () => {
    const matrix = createLayerTransform(100, 100, 100, 100, {
      ...identity,
      rotation: 90,
    })
    expect(matrix[0]).toBeCloseTo(0)
    expect(matrix[1]).toBeCloseTo(1)
    expect(matrix[3]).toBeCloseTo(-1)
    expect(matrix[4]).toBeCloseTo(0)
  })

  it.each([
    [0, 100, 100, 100],
    [100, 0, 100, 100],
    [100, 100, 0, 100],
    [100, 100, 100, Number.NaN],
  ])('rejects invalid dimensions (%s, %s, %s, %s)', (width, height, sourceWidth, sourceHeight) => {
    expect(() => createLayerTransform(width, height, sourceWidth, sourceHeight, identity))
      .toThrow('positive finite numbers')
  })
})
