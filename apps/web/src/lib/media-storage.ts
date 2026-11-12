const DATABASE_NAME = 'kyrocut-x1-browser'
const DATABASE_VERSION = 1
const MEDIA_STORE = 'media'

type StoredMedia = {
  id: string
  blob: Blob
  name: string
  mimeType: string
  size: number
  lastModified: number
}

let databasePromise: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('Persistent browser storage is not available in this environment'))
  }
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(MEDIA_STORE)) {
          database.createObjectStore(MEDIA_STORE, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        databasePromise = undefined
        reject(request.error ?? new Error('Could not open KYROCUT browser storage'))
      }
      request.onblocked = () => {
        databasePromise = undefined
        reject(new Error('KYROCUT browser storage upgrade is blocked by another open tab'))
      }
    })
  }
  return databasePromise
}

export async function saveMediaBlob(id: string, blob: Blob, name: string): Promise<void> {
  if (!id.trim() || !name.trim()) throw new Error('Media ID and filename are required')
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(MEDIA_STORE, 'readwrite')
    const record: StoredMedia = {
      id,
      blob,
      name,
      mimeType: blob.type,
      size: blob.size,
      lastModified: Date.now(),
    }
    transaction.objectStore(MEDIA_STORE).put(record)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save media to browser storage'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Media storage transaction was aborted'))
  })
}

export async function getMediaBlob(id: string): Promise<Blob | null> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(MEDIA_STORE, 'readonly')
    const request = transaction.objectStore(MEDIA_STORE).get(id)
    request.onsuccess = () => {
      const record = request.result as StoredMedia | undefined
      resolve(record?.blob instanceof Blob ? record.blob : null)
    }
    request.onerror = () => reject(request.error ?? new Error('Could not read media from browser storage'))
  })
}

export async function deleteMediaBlob(id: string): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(MEDIA_STORE, 'readwrite')
    transaction.objectStore(MEDIA_STORE).delete(id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not remove media from browser storage'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Media removal transaction was aborted'))
  })
}
