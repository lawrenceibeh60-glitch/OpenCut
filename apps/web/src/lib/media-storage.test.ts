import { describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { deleteMediaBlob, getMediaBlob, saveMediaBlob } from './media-storage'

describe('KYROCUT browser media storage', () => {
  it('persists and restores an imported media blob by stable asset ID', async () => {
    const id = 'media-persistence-round-trip'
    const original = new Blob(['KYROCUT media bytes'], { type: 'video/webm' })

    await saveMediaBlob(id, original, 'shot.webm')
    const restored = await getMediaBlob(id)

    expect(restored).not.toBeNull()
    expect(restored?.type).toBe('video/webm')
    expect(await restored?.text()).toBe('KYROCUT media bytes')
  })

  it('returns null for an asset that has not been stored', async () => {
    expect(await getMediaBlob('media-does-not-exist')).toBeNull()
  })

  it('removes a stored media blob', async () => {
    const id = 'media-persistence-delete'
    await saveMediaBlob(id, new Blob(['remove me']), 'remove.txt')
    await deleteMediaBlob(id)

    expect(await getMediaBlob(id)).toBeNull()
  })
})
