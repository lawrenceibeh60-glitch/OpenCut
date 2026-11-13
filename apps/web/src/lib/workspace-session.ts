let sessionToken: string | null = null
let initialization: Promise<string> | null = null

async function post(action: Record<string, unknown>) {
  const response = await fetch('/api/workspace', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: JSON.stringify(action),
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => ({})) as { token?: string; error?: string }
  if (!response.ok) throw new Error(payload.error || `Workspace request failed (${response.status})`)
  return payload
}

export function initializeWorkspaceSession(): Promise<string> {
  if (sessionToken) return Promise.resolve(sessionToken)
  if (!initialization) {
    initialization = post({ action: 'create' })
      .then((payload) => {
        if (!payload.token) throw new Error('Workspace service did not return a session token')
        sessionToken = payload.token
        return payload.token
      })
      .finally(() => { initialization = null })
  }
  return initialization
}

export async function saveWorkspaceManifest(manifest: unknown) {
  if (!sessionToken) throw new Error('Temporary workspace has not started')
  await post({ action: 'save', manifest })
}

export async function uploadWorkspaceMedia(id: string, file: Blob, name: string) {
  if (!sessionToken) return
  const payload = await post({
    action: 'upload-url',
    assetId: id,
    name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
  }) as { uploadUrl?: string }
  if (!payload.uploadUrl) throw new Error('Storage service did not return an upload URL')
  const response = await fetch(payload.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!response.ok) throw new Error(`Temporary media upload failed (${response.status})`)
}

export function disposeWorkspaceSession() {
  const token = sessionToken
  sessionToken = null
  if (!token) return
  void fetch('/api/workspace', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    keepalive: true,
  }).catch(() => undefined)
}
