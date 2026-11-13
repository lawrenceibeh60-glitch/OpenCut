import { uploadWorkspaceMedia } from './workspace-session'

// Media stays in this page's memory only. It is never written to IndexedDB,
// localStorage, Cache Storage, or another persistent browser store.
const media = new Map<string, Blob>()

export async function saveMediaBlob(id: string, blob: Blob, name: string): Promise<void> {
  if (!id.trim() || !name.trim()) throw new Error('Media ID and filename are required')
  media.set(id, blob)
  try {
    await uploadWorkspaceMedia(id, blob, name)
  } catch (error) {
    // The in-memory copy remains usable and can still be included in Export Draft.
    console.warn('KYROCUT temporary media sync failed:', error instanceof Error ? error.message : 'unknown error')
  }
}

export async function getMediaBlob(id: string): Promise<Blob | null> {
  return media.get(id) ?? null
}

export async function deleteMediaBlob(id: string): Promise<void> {
  media.delete(id)
}

export function clearSessionMedia(): void {
  media.clear()
}
