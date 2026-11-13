import { describe, expect, it } from 'vitest'
import { CREATIVE_FONTS, CREATIVE_LUT_ASSETS, CREATIVE_PRESETS, CREATIVE_ASSET_SOURCES, validateCreativePresets } from './creative-library'

describe('creative preset library', () => {
  it('contains a large, uniquely identified preset collection', () => {
    expect(CREATIVE_PRESETS.length).toBeGreaterThanOrEqual(250)
    expect(CREATIVE_FONTS.length).toBeGreaterThanOrEqual(100)
    expect(new Set(CREATIVE_FONTS).size).toBe(CREATIVE_FONTS.length)
    expect(CREATIVE_LUT_ASSETS).toHaveLength(15)
    expect(validateCreativePresets()).toBe(true)
    expect(new Set(CREATIVE_PRESETS.map((preset) => preset.id)).size).toBe(CREATIVE_PRESETS.length)
  })
  it('includes color, transition, motion and style families', () => {
    expect(new Set(CREATIVE_PRESETS.map((preset) => preset.kind))).toEqual(new Set(['grade','transition','motion','style']))
  })
  it('records asset source and license information', () => {
    expect(CREATIVE_ASSET_SOURCES.length).toBeGreaterThanOrEqual(5)
    expect(CREATIVE_ASSET_SOURCES.every((source) => source.url.startsWith('https://') && source.license.length > 0)).toBe(true)
  })
})
