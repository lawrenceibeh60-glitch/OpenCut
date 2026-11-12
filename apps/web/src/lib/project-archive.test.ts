import { describe, expect, it } from 'vitest'
import { decodeProjectArchive, encodeProjectArchive, isProjectArchive } from './project-archive'
import type { ProjectManifest } from './project-format'

const manifest: ProjectManifest = {
  format: 'kyrocut-project', version: 1, application: 'KYROCUT X1', id: 'project-1',
  name: 'Portable project', frameRate: { numerator: 30, denominator: 1 },
  resolution: { width: 1920, height: 1080 }, playheadFrame: 0,
  media: [
    { id: 'asset-a', name: 'same name.mp4', kind: 'video', size: 4, durationFrames: 30, mimeType: 'video/mp4', locator: 'media/same name.mp4' },
    { id: 'asset-b', name: 'same name.mp4', kind: 'video', size: 3, durationFrames: 30, mimeType: 'video/mp4', locator: 'media/same name.mp4' },
    { id: 'asset-c', name: 'offline.wav', kind: 'audio', size: 0, durationFrames: null, mimeType: 'audio/wav', locator: 'media/offline.wav' },
  ],
  tracks: [{ id: 'track-1', name: 'V1', kind: 'video', muted: false, locked: false, clips: [] }],
}

describe('KYROCUT X1 portable project archive', () => {
  it('bundles and restores media by stable asset ID, even with duplicate filenames', async () => {
    const media = new Map([
      ['asset-a', new Blob(['one'], { type: 'video/mp4' })],
      ['asset-b', new Blob(['two'], { type: 'video/mp4' })],
    ])
    const archive = await encodeProjectArchive(manifest, media)
    expect(await isProjectArchive(archive)).toBe(true)
    const restored = await decodeProjectArchive(archive)
    expect(restored.manifest.media[0].locator).toBe('media/asset-a/same name.mp4')
    expect(restored.manifest.media[1].locator).toBe('media/asset-b/same name.mp4')
    expect(await restored.media.get('asset-a')?.text()).toBe('one')
    expect(await restored.media.get('asset-b')?.text()).toBe('two')
    expect(restored.media.has('asset-c')).toBe(false)
  })

  it('rejects a damaged archive', async () => {
    await expect(decodeProjectArchive(new Blob(['not a zip']))).rejects.toThrow('directory')
  })

  it('keeps missing media references explicit instead of inventing file contents', async () => {
    const archive = await encodeProjectArchive(manifest, new Map())
    const restored = await decodeProjectArchive(archive)
    expect(restored.media.size).toBe(0)
    expect(restored.manifest.media).toHaveLength(3)
  })
})
