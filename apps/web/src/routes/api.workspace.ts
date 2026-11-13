import { createFileRoute } from '@tanstack/react-router'

type WorkspaceManifest = Record<string, unknown>
type WorkspaceAction =
  | { action: 'create' }
  | { action: 'touch' }
  | { action: 'save'; manifest: WorkspaceManifest }
  | { action: 'upload-url'; assetId: string; name: string; mimeType: string; size: number }

const SESSION_TTL_MINUTES = 120
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024
let bucketCorsConfigured = false
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

function databaseUrl() {
  const value = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL
  if (!value) throw new Error('DATABASE_URL_POOLED or DATABASE_URL is not configured')
  return value
}

async function sqlClient() {
  const { neon } = await import('@neondatabase/serverless')
  return neon(databaseUrl())
}

async function ensureSchema(sql: Awaited<ReturnType<typeof sqlClient>>) {
  await sql`CREATE TABLE IF NOT EXISTS kyrocut_workspace_sessions (
    session_hash text PRIMARY KEY,
    manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  )`
  await sql`CREATE INDEX IF NOT EXISTS kyrocut_workspace_sessions_expiry_idx ON kyrocut_workspace_sessions (expires_at)`
}

async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

function bearer(request: Request) {
  const value = request.headers.get('authorization') || ''
  return value.startsWith('Bearer ') ? value.slice(7).trim() : ''
}

async function s3Client() {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  if (!endpoint || !accessKeyId || !secretAccessKey || !process.env.S3_BUCKET) {
    throw new Error('Temporary S3 storage is not fully configured')
  }
  const [{ S3Client }, { getSignedUrl }] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/s3-request-presigner'),
  ])
  const client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-2',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })
  return { client, getSignedUrl, bucket: process.env.S3_BUCKET }
}

async function ensureBucketCors(client: import('@aws-sdk/client-s3').S3Client, bucket: string) {
  if (bucketCorsConfigured) return
  const { PutBucketCorsCommand } = await import('@aws-sdk/client-s3')
  await client.send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: ['https://kyrocut-x1-web.onrender.com', 'http://localhost:5173'],
        AllowedMethods: ['GET', 'PUT', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
      }],
    },
  }))
  bucketCorsConfigured = true
}

async function deleteSessionObjects(sessionHash: string): Promise<boolean> {
  try {
    const { client, bucket } = await s3Client()
    const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3')
    let continuationToken: string | undefined
    do {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `sessions/${sessionHash}/`,
        ContinuationToken: continuationToken,
      }))
      const objects = (page.Contents || []).flatMap((item) => item.Key ? [{ Key: item.Key }] : [])
      if (objects.length) {
        await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }))
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (continuationToken)
    return true
  } catch (error) {
    console.error('KYROCUT temporary asset cleanup failed:', error instanceof Error ? error.message : 'unknown error')
    return false
  }
}

async function cleanupExpired(sql: Awaited<ReturnType<typeof sqlClient>>) {
  const expired = await sql`SELECT session_hash FROM kyrocut_workspace_sessions WHERE expires_at < now() LIMIT 50` as Array<{ session_hash: string }>
  for (const row of expired) {
    if (await deleteSessionObjects(row.session_hash)) {
      await sql`DELETE FROM kyrocut_workspace_sessions WHERE session_hash = ${row.session_hash} AND expires_at < now()`
    }
  }
}

async function authorizedSession(request: Request, sql: Awaited<ReturnType<typeof sqlClient>>) {
  const token = bearer(request)
  if (!token || token.length > 256) return null
  const sessionHash = await hashToken(token)
  const rows = await sql`SELECT session_hash FROM kyrocut_workspace_sessions WHERE session_hash = ${sessionHash} AND expires_at > now() LIMIT 1`
  return rows.length ? sessionHash : null
}

async function handlePost(request: Request) {
  try {
    const body = await request.json() as WorkspaceAction
    const sql = await sqlClient()
    await ensureSchema(sql)

    if (body?.action === 'create') {
      await cleanupExpired(sql)
      const token = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`
      const sessionHash = await hashToken(token)
      await sql`INSERT INTO kyrocut_workspace_sessions (session_hash, manifest, expires_at)
        VALUES (${sessionHash}, '{}'::jsonb, now() + interval '120 minutes')`
      return json({ token, expiresInSeconds: SESSION_TTL_MINUTES * 60 })
    }

    const sessionHash = await authorizedSession(request, sql)
    if (!sessionHash) return json({ error: 'Workspace session expired or invalid. Start a new temporary workspace.' }, 401)

    if (body?.action === 'touch') {
      await sql`UPDATE kyrocut_workspace_sessions SET updated_at = now(), expires_at = now() + interval '120 minutes' WHERE session_hash = ${sessionHash}`
      return json({ ok: true })
    }

    if (body?.action === 'save') {
      const serialized = JSON.stringify(body.manifest ?? {})
      if (new TextEncoder().encode(serialized).byteLength > MAX_MANIFEST_BYTES) {
        return json({ error: 'Workspace document exceeds the 5 MB temporary session limit.' }, 413)
      }
      await sql`UPDATE kyrocut_workspace_sessions
        SET manifest = ${serialized}::jsonb, updated_at = now(),
            expires_at = now() + (${SESSION_TTL_MINUTES} || ' minutes')::interval
        WHERE session_hash = ${sessionHash}`
      return json({ ok: true })
    }

    if (body?.action === 'upload-url') {
      if (typeof body.assetId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(body.assetId) || typeof body.name !== 'string' || !Number.isSafeInteger(body.size) || body.size < 0 || body.size > 2 * 1024 * 1024 * 1024) {
        return json({ error: 'Invalid media asset metadata.' }, 400)
      }
      const { client, getSignedUrl, bucket } = await s3Client()
      try { await ensureBucketCors(client, bucket) } catch (error) {
        console.warn('KYROCUT bucket CORS could not be updated; existing bucket CORS must allow the editor origin:', error instanceof Error ? error.message : 'unknown error')
      }
      const { PutObjectCommand } = await import('@aws-sdk/client-s3')
      const safeName = body.name.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 180) || 'media.bin'
      const key = `sessions/${sessionHash}/media/${body.assetId}/${safeName}`
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: (body.mimeType || 'application/octet-stream').slice(0, 160),
      })
      const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 })
      await sql`UPDATE kyrocut_workspace_sessions SET updated_at = now(), expires_at = now() + (${SESSION_TTL_MINUTES} || ' minutes')::interval WHERE session_hash = ${sessionHash}`
      return json({ uploadUrl, key })
    }

    return json({ error: 'Unsupported workspace action.' }, 400)
  } catch (error) {
    console.error('KYROCUT workspace API error:', error instanceof Error ? error.message : 'unknown error')
    return json({ error: 'Temporary workspace service is unavailable. Check the server configuration.' }, 503)
  }
}

async function handleDelete(request: Request) {
  try {
    const sql = await sqlClient()
    await ensureSchema(sql)
    const sessionHash = await authorizedSession(request, sql)
    if (!sessionHash) return new Response(null, { status: 204 })
    const cleaned = await deleteSessionObjects(sessionHash)
    if (cleaned) await sql`DELETE FROM kyrocut_workspace_sessions WHERE session_hash = ${sessionHash}`
    else await sql`UPDATE kyrocut_workspace_sessions SET expires_at = now() - interval '1 second' WHERE session_hash = ${sessionHash}`
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  } catch {
    return new Response(null, { status: 204 })
  }
}

export const Route = createFileRoute('/api/workspace')({
  server: {
    handlers: {
      POST: ({ request }) => handlePost(request),
      DELETE: ({ request }) => handleDelete(request),
    },
  },
})
