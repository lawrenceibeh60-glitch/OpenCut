import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./workspace-session', () => ({
  uploadWorkspaceMedia: vi.fn().mockResolvedValue(undefined),
}))

import { clearSessionMedia, deleteMediaBlob, getMediaBlob, saveMediaBlob } from './media-storage'

describe('KYROCUT temporary media storage', () => {
  beforeEach(() => clearSessionMedia())

  it('keeps imported media available during the current page session', async () => {
    const id = 'media-session-round-trip'
    const original = new Blob(['KYROCUT media bytes'], { type: 'video/webm' })

    await saveMediaBlob(id, original, 'shot.webm')
    const restored = await getMediaBlob(id)

    expect(restored).not.toBeNull()
    expect(restored?.type).toBe('video/webm')
    expect(await restored?.text()).toBe('KYROCUT media bytes')
  })

  it('starts empty after the page session is cleared', async () => {
    const id = 'media-session-refresh'
    await saveMediaBlob(id, new Blob(['unsaved']), 'unsaved.webm')

    clearSessionMedia()

    expect(await getMediaBlob(id)).toBeNull()
  })

  it('returns null for an asset that has not been stored', async () => {
    expect(await getMediaBlob('media-does-not-exist')).toBeNull()
  })

  it('removes a media blob from the current page session', async () => {
    const id = 'media-session-delete'
    await saveMediaBlob(id, new Blob(['remove me']), 'remove.txt')
    await deleteMediaBlob(id)

    expect(await getMediaBlob(id)).toBeNull()
  })
})
