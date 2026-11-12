import { parseProjectManifest, type ProjectManifest } from './project-format'

const ZIP_LOCAL = 0x04034b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_END = 0x06054b50
const UTF8_FLAG = 0x0800
const MAX_ZIP32_SIZE = 0xffffffff
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type DecodedProjectArchive = {
  manifest: ProjectManifest
  media: Map<string, Blob>
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[\\/\\\\]/g, '_').replace(/[\\u0000-\\u001f]/g, '').trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 180) : 'media.bin'
}

function write16(view: DataView, offset: number, value: number) { view.setUint16(offset, value, true) }
function write32(view: DataView, offset: number, value: number) { view.setUint32(offset, value >>> 0, true) }

export async function encodeProjectArchive(
  input: ProjectManifest,
  mediaBlobs: ReadonlyMap<string, Blob>,
): Promise<Blob> {
  const manifest: ProjectManifest = {
    ...input,
    media: input.media.map((asset) => ({
      ...asset,
      locator: mediaBlobs.has(asset.id)
        ? `media/${asset.id}/${safeFilename(asset.name)}`
        : asset.locator,
    })),
  }
  const files: Array<{ name: string; blob: Blob; crc: number; size: number; nameBytes: Uint8Array; offset: number }> = []
  const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })
  const entries = [{ name: 'project.json', blob: manifestBlob }, ...manifest.media.flatMap((asset) => {
    const blob = mediaBlobs.get(asset.id)
    return blob ? [{ name: `media/${asset.id}/${safeFilename(asset.name)}`, blob }] : []
  })]

  let offset = 0
  const output: BlobPart[] = []
  const central: Uint8Array[] = []
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    if (nameBytes.length > 0xffff || entry.blob.size > MAX_ZIP32_SIZE) {
      throw new Error('A project archive entry exceeds the supported ZIP32 size')
    }
    const bytes = new Uint8Array(await entry.blob.arrayBuffer())
    const checksum = crc32(bytes)
    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    write32(localView, 0, ZIP_LOCAL)
    write16(localView, 4, 20)
    write16(localView, 6, UTF8_FLAG)
    write16(localView, 8, 0)
    write32(localView, 14, checksum)
    write32(localView, 18, bytes.length)
    write32(localView, 22, bytes.length)
    write16(localView, 26, nameBytes.length)
    local.set(nameBytes, 30)
    output.push(local, bytes)
    const directory = new Uint8Array(46 + nameBytes.length)
    const directoryView = new DataView(directory.buffer)
    write32(directoryView, 0, ZIP_CENTRAL)
    write16(directoryView, 4, 20)
    write16(directoryView, 6, 20)
    write16(directoryView, 8, UTF8_FLAG)
    write16(directoryView, 10, 0)
    write32(directoryView, 16, checksum)
    write32(directoryView, 20, bytes.length)
    write32(directoryView, 24, bytes.length)
    write16(directoryView, 28, nameBytes.length)
    write32(directoryView, 42, offset)
    directory.set(nameBytes, 46)
    central.push(directory)
    files.push({ name: entry.name, blob: entry.blob, crc: checksum, size: bytes.length, nameBytes, offset })
    offset += local.length + bytes.length
    if (offset > MAX_ZIP32_SIZE) throw new Error('This project is too large for the supported ZIP32 archive format')
  }
  const centralOffset = offset
  for (const directory of central) {
    output.push(directory)
    offset += directory.length
  }
  const centralSize = offset - centralOffset
  if (files.length > 0xffff || offset > MAX_ZIP32_SIZE) {
    throw new Error('This project contains too many files or exceeds the supported archive size')
  }
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  write32(endView, 0, ZIP_END)
  write16(endView, 8, files.length)
  write16(endView, 10, files.length)
  write32(endView, 12, centralSize)
  write32(endView, 16, centralOffset)
  output.push(end)
  return new Blob(output, { type: 'application/vnd.kyrocut.project+zip' })
}

export async function isProjectArchive(file: Blob): Promise<boolean> {
  if (file.size < 4) return false
  const signature = new DataView(await file.slice(0, 4).arrayBuffer()).getUint32(0, true)
  return signature === ZIP_LOCAL
}

export async function decodeProjectArchive(file: Blob): Promise<DecodedProjectArchive> {
  const tailStart = Math.max(0, file.size - 0xffff - 22)
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer())
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let endOffset = -1
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tailView.getUint32(i, true) === ZIP_END) { endOffset = i; break }
  }
  if (endOffset < 0) throw new Error('Project archive directory is missing or damaged')
  const count = tailView.getUint16(endOffset + 10, true)
  const directorySize = tailView.getUint32(endOffset + 12, true)
  const directoryOffset = tailView.getUint32(endOffset + 16, true)
  if (directoryOffset + directorySize > file.size || count > 10000) {
    throw new Error('Project archive directory contains invalid bounds')
  }
  const directory = new DataView(await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer())
  const records = new Map<string, { offset: number; size: number; method: number; crc: number }>()
  let cursor = 0
  for (let i = 0; i < count; i += 1) {
    if (directory.getUint32(cursor, true) !== ZIP_CENTRAL) throw new Error('Project archive directory entry is invalid')
    const method = directory.getUint16(cursor + 10, true)
    const crc = directory.getUint32(cursor + 16, true)
    const compressedSize = directory.getUint32(cursor + 20, true)
    const size = directory.getUint32(cursor + 24, true)
    const nameLength = directory.getUint16(cursor + 28, true)
    const extraLength = directory.getUint16(cursor + 30, true)
    const commentLength = directory.getUint16(cursor + 32, true)
    const localOffset = directory.getUint32(cursor + 42, true)
    const nameBytes = new Uint8Array(directory.buffer, directory.byteOffset + cursor + 46, nameLength)
    const name = decoder.decode(nameBytes)
    if (records.has(name)) throw new Error('Project archive contains duplicate paths')
    if (method !== 0 || compressedSize !== size) throw new Error('Unsupported compressed project archive entry')
    records.set(name, { offset: localOffset, size, method, crc })
    cursor += 46 + nameLength + extraLength + commentLength
    if (cursor > directory.byteLength) throw new Error('Project archive directory is truncated')
  }
  const manifestRecord = records.get('project.json')
  if (!manifestRecord) throw new Error('Project archive does not contain project.json')
  const manifestHeader = new DataView(await file.slice(manifestRecord.offset, manifestRecord.offset + 30).arrayBuffer())
  if (manifestHeader.getUint32(0, true) !== ZIP_LOCAL) throw new Error('Project archive manifest header is invalid')
  const manifestNameLength = manifestHeader.getUint16(26, true)
  const manifestExtraLength = manifestHeader.getUint16(28, true)
  const manifestStart = manifestRecord.offset + 30 + manifestNameLength + manifestExtraLength
  const manifestBlob = file.slice(manifestStart, manifestStart + manifestRecord.size)
  const manifest = parseProjectManifest(await manifestBlob.text())
  const media = new Map<string, Blob>()
  for (const asset of manifest.media) {
    const record = records.get(asset.locator)
    if (!record || !asset.locator.startsWith(`media/${asset.id}/`)) continue
    const header = new DataView(await file.slice(record.offset, record.offset + 30).arrayBuffer())
    if (header.getUint32(0, true) !== ZIP_LOCAL) throw new Error('Media archive entry header is invalid')
    const nameLength = header.getUint16(26, true)
    const extraLength = header.getUint16(28, true)
    const start = record.offset + 30 + nameLength + extraLength
    const blob = file.slice(start, start + record.size, asset.mimeType || 'application/octet-stream')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (crc32(bytes) !== record.crc) throw new Error(`Media archive entry failed integrity validation: ${asset.name}`)
    media.set(asset.id, blob)
  }
  return { manifest, media }
}
