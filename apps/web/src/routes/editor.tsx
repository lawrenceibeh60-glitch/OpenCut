import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { framesToSeconds, secondsToFrames, SEQUENCE_FRAME_RATE } from '../lib/timebase'
import type { RationalFrameRate } from '../lib/timebase'
import { parseProjectManifest, type ClipEffects, type ProjectManifest } from '../lib/project-format'
import { getMediaBlob, saveMediaBlob } from '../lib/media-storage'
import { clampTimelineTime, getActivePlaybackClips, getPrimaryPreviewClip } from '../lib/timeline-playback'
import { decodeProjectArchive, encodeProjectArchive, isProjectArchive } from '../lib/project-archive'
import {
  AudioLines, ChevronDown, Clapperboard, Film, FolderOpen, ImagePlus, Layers3,
  Minus, Music2, Pause, Play, Plus, Save, Scissors, Settings2, Sparkles, StepBack, StepForward, Trash2,
  Upload, Video, Volume2, WandSparkles,
} from 'lucide-react'
import './editor.css'
import './editor-extra.css'

export const Route = createFileRoute('/editor')({ component: Editor })

type MediaKind = 'video' | 'audio' | 'image'
type MediaAsset = { id: string; name: string; kind: MediaKind; url: string; size: number; duration: number; durationKnown: boolean; mimeType: string; missing?: boolean }
type TimelineClip = { id: string; mediaId: string; start: number; sourceIn: number; duration: number; enabled: boolean; effects?: ClipEffects }
type TimelineTrack = { id: string; name: string; kind: 'video' | 'audio' | 'graphics' | 'adjustment'; clips: TimelineClip[]; muted: boolean; locked: boolean }

const createId = () => globalThis.crypto?.randomUUID?.() ?? `kyro-${Date.now()}-${Math.random().toString(16).slice(2)}`
const formatTime = (seconds: number, rate: RationalFrameRate = SEQUENCE_FRAME_RATE) => {
  const safe = Math.max(0, seconds)
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}:${String(Math.floor((safe % 1) * rate.numerator / rate.denominator)).padStart(2, '0')}`
}
const mediaKind = (file: File): MediaKind | null => file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : null
const formatFrameRate = (rate: RationalFrameRate) => `${Number((rate.numerator / rate.denominator).toFixed(3))} FPS`
const DEFAULT_CLIP_EFFECTS: ClipEffects = { brightness: 100, contrast: 100, saturation: 100, blur: 0, grayscale: 0, sepia: 0, hueRotate: 0, opacity: 100 }

function Editor() {
  const [assets, setAssets] = useState<MediaAsset[]>([])
  const [tracks, setTracks] = useState<TimelineTrack[]>([
    { id: 'video-1', name: 'V1', kind: 'video', clips: [], muted: false, locked: false },
    { id: 'video-2', name: 'V2', kind: 'video', clips: [], muted: false, locked: false },
    { id: 'audio-1', name: 'A1', kind: 'audio', clips: [], muted: false, locked: false },
  ])
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [activeTab, setActiveTab] = useState<'media' | 'effects' | 'text'>('media')
  const [titleText, setTitleText] = useState('YOUR TITLE')
  const [projectName, setProjectName] = useState('Untitled project')
  const [projectId, setProjectId] = useState<string>(createId())
  const [projectFrameRate, setProjectFrameRate] = useState<RationalFrameRate>(SEQUENCE_FRAME_RATE)
  const [projectResolution, setProjectResolution] = useState({ width: 1920, height: 1080 })
  const [notice, setNotice] = useState('Import media to begin editing')
  const [recoveryReady, setRecoveryReady] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const relinkInput = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const objectUrls = useRef<string[]>([])
  useEffect(() => () => objectUrls.current.forEach((url) => URL.revokeObjectURL(url)), [])

  useEffect(() => {
    let active = true
    const recover = async () => {
      try {
        const saved = localStorage.getItem('kyrocut-x1:recovery')
        if (saved) {
          const manifest = parseProjectManifest(saved)
          if (manifest.format === 'kyrocut-project' && manifest.version === 1 && Array.isArray(manifest.media) && Array.isArray(manifest.tracks)) {
            const frameRate = manifest.frameRate?.numerator && manifest.frameRate?.denominator ? manifest.frameRate : SEQUENCE_FRAME_RATE
            const restoredAssets = await Promise.all(manifest.media.map(async (asset) => {
              const blob = await getMediaBlob(asset.id).catch(() => null)
              const url = blob ? URL.createObjectURL(blob) : ''
              if (url) objectUrls.current.push(url)
              return {
                id: asset.id, name: asset.name, kind: asset.kind, url,
                size: blob?.size ?? asset.size ?? 0,
                duration: framesToSeconds(asset.durationFrames ?? 0, frameRate),
                durationKnown: asset.durationFrames !== null,
                mimeType: blob?.type ?? asset.mimeType ?? '',
                missing: !blob,
              }
            }))
            if (!active) {
              restoredAssets.forEach((asset) => { if (asset.url) URL.revokeObjectURL(asset.url) })
              return
            }
            setProjectFrameRate(frameRate)
            setProjectResolution(manifest.resolution)
            setAssets(restoredAssets)
            setTracks(manifest.tracks.map((track) => ({
              id: track.id, name: track.name, kind: track.kind,
              muted: Boolean(track.muted), locked: Boolean(track.locked),
              clips: track.clips.map((clip) => ({
                id: clip.id, mediaId: clip.mediaId,
                start: framesToSeconds(clip.timelineStartFrame, frameRate),
                sourceIn: framesToSeconds(clip.sourceInFrame, frameRate),
                duration: framesToSeconds(clip.durationFrames, frameRate), enabled: clip.enabled, effects: clip.effects,
              })),
            })))
            setProjectId(manifest.id ?? createId())
            setProjectName(manifest.name || 'Recovered project')
            setPlayhead(framesToSeconds(manifest.playheadFrame ?? 0, frameRate))
            const offline = restoredAssets.filter((asset) => !asset.url).length
            setNotice(offline
              ? `Recovered project. ${offline} source file(s) need relinking.`
              : 'Recovered project and restored its locally stored media.')
          }
        }
      } catch {
        if (active) setNotice('Local recovery snapshot could not be read; starting a fresh project.')
      } finally {
        if (active) setRecoveryReady(true)
      }
    }
    void recover()
    return () => { active = false }
  }, [])

  const allClips = useMemo(() => tracks.flatMap((track) => track.clips.map((clip) => ({ ...clip, trackId: track.id }))), [tracks])
  const selectedClip = allClips.find((clip) => clip.id === selectedClipId) ?? null
  useEffect(() => {
    const active = getActivePlaybackClips(tracks, playhead)
    const candidate = getPrimaryPreviewClip(active)
    if (candidate && candidate.clip.id !== selectedClipId) setSelectedClipId(candidate.clip.id)
  }, [playhead, tracks, selectedClipId])
  const selectedAsset = assets.find((asset) => asset.id === selectedClip?.mediaId) ?? null
  const projectDuration = Math.max(30, ...allClips.filter((clip) => clip.enabled).map((clip) => clip.start + clip.duration))
  const selectedTrack = tracks.find((track) => track.clips.some((clip) => clip.id === selectedClipId))
  const missingAssets = assets.filter((asset) => !asset.url)
  const selectedEffects = selectedClip?.effects ?? DEFAULT_CLIP_EFFECTS
  const previewFilter = `brightness(${selectedEffects.brightness}%) contrast(${selectedEffects.contrast}%) saturate(${selectedEffects.saturation}%) blur(${selectedEffects.blur}px) grayscale(${selectedEffects.grayscale}%) sepia(${selectedEffects.sepia}%) hue-rotate(${selectedEffects.hueRotate}deg)`
  const updateEffect = (patch: Partial<ClipEffects>) => updateSelectedClip({ effects: { ...selectedEffects, ...patch } })

  const projectDocument = useMemo(() => ({
    format: 'kyrocut-project', version: 1, application: 'KYROCUT X1',
    id: projectId, name: projectName, frameRate: projectFrameRate, resolution: projectResolution,
    media: assets.map(({ id, name, kind, size, duration, durationKnown, mimeType }) => ({
      id, name, kind, size, durationFrames: durationKnown ? secondsToFrames(duration, projectFrameRate) : null,
      mimeType, locator: `media/${name}`,
    })),
    tracks: tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => ({
        id: clip.id, mediaId: clip.mediaId,
        timelineStartFrame: secondsToFrames(clip.start, projectFrameRate),
        sourceInFrame: secondsToFrames(clip.sourceIn, projectFrameRate),
        durationFrames: Math.max(1, secondsToFrames(clip.duration, projectFrameRate)),
        enabled: clip.enabled,
        ...(clip.effects ? { effects: clip.effects } : {}),
      })),
    })),
    playheadFrame: secondsToFrames(playhead, projectFrameRate),
  }), [assets, playhead, projectFrameRate, projectId, projectName, projectResolution, tracks])

  useEffect(() => {
    if (!recoveryReady) return
    try {
      localStorage.setItem('kyrocut-x1:recovery', JSON.stringify(projectDocument))
    } catch {
      setNotice('Automatic recovery storage is full or unavailable. Save a .kcx1 project file manually.')
    }
  }, [projectDocument, recoveryReady])

  useEffect(() => {
    const sourceTime = selectedClip ? selectedClip.sourceIn + Math.max(0, playhead - selectedClip.start) : 0
    const media = videoRef.current ?? audioRef.current
    if (!media) return
    if (!playing && Number.isFinite(sourceTime) && Math.abs(media.currentTime - sourceTime) > 0.04) {
      try { media.currentTime = sourceTime } catch { /* metadata may not be ready yet */ }
    }
    if (playing && media.paused) void media.play().catch(() => setPlaying(false))
    if (!playing && !media.paused) media.pause()
  }, [selectedAsset?.id, selectedClip?.id, playhead, playing])

  useEffect(() => {
    if (!playing) return
    let request = 0
    const startedAt = performance.now()
    const startTime = playhead
    const tick = (now: number) => {
      const next = clampTimelineTime(startTime + (now - startedAt) / 1000, projectDuration)
      setPlayhead(next)
      if (next >= projectDuration) {
        setPlaying(false)
        return
      }
      request = requestAnimationFrame(tick)
    }
    request = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(request)
  }, [playing, projectDuration])

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const accepted = Array.from(files).filter((file) => mediaKind(file))
    if (!accepted.length) { setNotice('Choose a video, audio or image file'); return }
    const additions: MediaAsset[] = []
    let storageFailures = 0
    for (const file of accepted) {
      const kind = mediaKind(file)
      if (!kind) continue
      let duration = kind === 'image' ? 5 : 0
      if (kind !== 'image') {
        const probeUrl = URL.createObjectURL(file)
        duration = await new Promise<number>((resolve) => {
          const probe = document.createElement(kind === 'video' ? 'video' : 'audio')
          probe.preload = 'metadata'
          probe.onloadedmetadata = () => { const value = Number.isFinite(probe.duration) ? probe.duration : 0; URL.revokeObjectURL(probeUrl); resolve(value) }
          probe.onerror = () => { URL.revokeObjectURL(probeUrl); resolve(0) }
          probe.src = probeUrl
        })
      }
      const id = createId()
      let stored = true
      try {
        await saveMediaBlob(id, file, file.name)
      } catch {
        stored = false
      }
      const assetUrl = URL.createObjectURL(file)
      objectUrls.current.push(assetUrl)
      additions.push({ id, name: file.name, kind, url: assetUrl, size: file.size, duration: duration || 8, durationKnown: kind === 'image' || duration > 0, mimeType: file.type })
      if (!stored) storageFailures += 1
    }
    setAssets((current) => [...current, ...additions])
    setNotice(storageFailures
      ? `Imported ${additions.length} media item(s), but browser storage could not retain ${storageFailures} file(s). Keep those originals safe.`
      : `Imported ${additions.length} media item(s) and saved them to browser storage.`)
  }, [])

  const addAssetToTimeline = (asset: MediaAsset) => {
    const targetKind = asset.kind === 'audio' ? 'audio' : 'video'
    let target = tracks.find((track) => track.kind === targetKind && !track.locked)
    if (!target) {
      const id = createId()
      target = { id, name: `${targetKind === 'audio' ? 'A' : 'V'}${tracks.filter((track) => track.kind === targetKind).length + 1}`, kind: targetKind, clips: [], muted: false, locked: false }
      setTracks((current) => [...current, target!])
    }
    const clip: TimelineClip = { id: createId(), mediaId: asset.id, start: playhead, sourceIn: 0, duration: Math.max(framesToSeconds(1, projectFrameRate), asset.duration), enabled: true }
    setTracks((current) => current.map((track) => track.id === target!.id ? { ...track, clips: [...track.clips, clip] } : track))
    setSelectedClipId(clip.id)
    setNotice(`Added ${asset.name} to ${target.name}`)
  }

  const updateSelectedClip = (patch: Partial<TimelineClip>) => {
    if (!selectedClipId || !selectedClip) return
    const asset = assets.find((item) => item.id === selectedClip.mediaId)
    const oneFrame = framesToSeconds(1, projectFrameRate)
    const requestedSourceIn = Math.max(0, patch.sourceIn ?? selectedClip.sourceIn)
    const sourceIn = asset && asset.durationKnown
      ? Math.min(requestedSourceIn, Math.max(0, asset.duration - oneFrame))
      : requestedSourceIn
    const maximumDuration = asset && asset.durationKnown
      ? Math.max(oneFrame, asset.duration - sourceIn)
      : Number.POSITIVE_INFINITY
    const duration = Math.min(
      Math.max(oneFrame, patch.duration ?? selectedClip.duration),
      maximumDuration,
    )
    setTracks((current) => current.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => clip.id === selectedClipId ? {
        ...clip, ...patch, duration, start: Math.max(0, patch.start ?? clip.start), sourceIn,
      } : clip),
    })))
  }
  const moveClipOnTimeline = (clipId: string, targetTrackId: string, startSeconds: number) => {
    const sourceTrack = tracks.find((track) => track.clips.some((clip) => clip.id === clipId))
    const targetTrack = tracks.find((track) => track.id === targetTrackId)
    const clip = sourceTrack?.clips.find((item) => item.id === clipId)
    const asset = assets.find((item) => item.id === clip?.mediaId)
    if (!sourceTrack || !targetTrack || !clip || !asset) return
    if (sourceTrack.locked) { setNotice('Unlock the source track before moving this clip'); return }
    if (targetTrack.locked) { setNotice('That track is locked'); return }
    const compatible = asset.kind === 'audio'
      ? targetTrack.kind === 'audio'
      : targetTrack.kind === 'video' || (asset.kind === 'image' && targetTrack.kind === 'graphics')
    if (!compatible) { setNotice('That media type cannot be placed on this track'); return }
    const snappedStart = framesToSeconds(secondsToFrames(Math.max(0, startSeconds), projectFrameRate), projectFrameRate)
    setTracks((current) => current.map((track) => {
      if (track.id === sourceTrack.id && track.id === targetTrack.id) {
        return { ...track, clips: [...track.clips.filter((item) => item.id !== clipId), { ...clip, start: snappedStart }].sort((a, b) => a.start - b.start) }
      }
      if (track.id === sourceTrack.id) return { ...track, clips: track.clips.filter((item) => item.id !== clipId) }
      if (track.id === targetTrack.id) return { ...track, clips: [...track.clips, { ...clip, start: snappedStart }].sort((a, b) => a.start - b.start) }
      return track
    }))
    setSelectedClipId(clipId)
    setPlayhead(snappedStart)
    setNotice('Moved clip to ' + targetTrack.name)
  }

  const splitSelectedClip = () => {
    if (!selectedClip) return
    const relativePlayhead = playhead - selectedClip.start
    if (relativePlayhead <= 0 || relativePlayhead >= selectedClip.duration) {
      setNotice('Move the playhead inside the selected clip to split it')
      return
    }
    const oneFrame = framesToSeconds(1, projectFrameRate)
    const splitOffset = framesToSeconds(secondsToFrames(relativePlayhead, projectFrameRate), projectFrameRate)
    if (splitOffset < oneFrame || splitOffset > selectedClip.duration - oneFrame) {
      setNotice('Move the playhead inside the selected clip to split it')
      return
    }
    const rightClip: TimelineClip = {
      id: createId(), mediaId: selectedClip.mediaId, start: selectedClip.start + splitOffset,
      sourceIn: selectedClip.sourceIn + splitOffset, duration: selectedClip.duration - splitOffset, enabled: selectedClip.enabled,
    }
    setTracks((current) => current.map((track) => track.id === selectedClip.trackId
      ? { ...track, clips: track.clips.flatMap((clip) => clip.id === selectedClip.id
        ? [{ ...clip, duration: splitOffset }, rightClip] : [clip]) }
      : track))
    setSelectedClipId(rightClip.id)
    setPlayhead(selectedClip.start + splitOffset)
    setNotice('Clip split at the playhead')
  }
  const removeSelectedClip = () => {
    if (!selectedClipId) return
    setTracks((current) => current.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== selectedClipId) })))
    setSelectedClipId(null)
    setNotice('Clip removed from timeline')
  }
  const addTrack = (kind: TimelineTrack['kind']) => {
    const prefix = kind === 'audio' ? 'A' : kind === 'graphics' ? 'G' : kind === 'adjustment' ? 'ADJ' : 'V'
    const number = tracks.filter((track) => track.kind === kind).length + 1
    setTracks((current) => [...current, { id: createId(), name: `${prefix}${number}`, kind, clips: [], muted: false, locked: false }])
  }

  const createTextLayer = async () => {
    const text = titleText.trim()
    if (!text) { setNotice('Enter some text before creating a title layer'); return }
    const xmlSafe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    const lines = xmlSafe.split(/\r?\n/)
    const lineHeight = 96
    const firstY = 540 - ((lines.length - 1) * lineHeight) / 2
    const tspans = lines.map((line, index) => `<tspan x="960" y="${firstY + index * lineHeight}">${line || ' '}</tspan>`).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><text text-anchor="middle" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="88" font-weight="700" letter-spacing="1" fill="#ffffff" stroke="#111111" stroke-width="3" paint-order="stroke">${tspans}</text></svg>`
    const file = new File([svg], `Title-${Date.now()}.svg`, { type: 'image/svg+xml' })
    const id = createId()
    try {
      await saveMediaBlob(id, file, file.name)
      const url = URL.createObjectURL(file)
      objectUrls.current.push(url)
      const asset: MediaAsset = { id, name: file.name, kind: 'image', url, size: file.size, duration: 5, durationKnown: true, mimeType: file.type }
      setAssets((current) => [...current, asset])
      const existing = tracks.find((track) => track.kind === 'graphics' && !track.locked)
      const target = existing ?? {
        id: createId(), name: `G${tracks.filter((track) => track.kind === 'graphics').length + 1}`,
        kind: 'graphics' as const, clips: [], muted: false, locked: false,
      }
      if (!existing) setTracks((current) => [...current, target])
      const clip: TimelineClip = { id: createId(), mediaId: id, start: playhead, sourceIn: 0, duration: 5, enabled: true }
      setTracks((current) => current.map((track) => track.id === target.id
        ? { ...track, clips: [...track.clips, clip].sort((a, b) => a.start - b.start) }
        : track))
      setSelectedClipId(clip.id)
      setActiveTab('effects')
      setNotice('Created a vector title layer on ' + target.name)
    } catch (error) {
      setNotice(error instanceof Error ? 'Could not save title layer: ' + error.message : 'Could not save title layer')
    }
  }
  const saveProject = async () => {
    try {
      const bundledMedia = new Map<string, Blob>()
      let unavailable = 0
      for (const asset of assets) {
        let blob = await getMediaBlob(asset.id).catch(() => null)
        if (!blob && asset.url) {
          try {
            const response = await fetch(asset.url)
            if (response.ok) blob = await response.blob()
          } catch {
            // A revoked or unavailable object URL is reported as missing below.
          }
        }
        if (blob) bundledMedia.set(asset.id, blob)
        else unavailable += 1
      }
      const archive = await encodeProjectArchive(projectDocument as ProjectManifest, bundledMedia)
      const url = URL.createObjectURL(archive)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${projectName.trim().replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'kyrocut-project'}.kcx1`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice(unavailable
        ? `Portable project saved with ${bundledMedia.size} media file(s); ${unavailable} unavailable source(s) remain offline.`
        : `Portable project saved with all ${bundledMedia.size} media file(s) bundled.`)
    } catch (error) {
      setNotice(error instanceof Error ? `Project save failed: ${error.message}` : 'Project save failed. Your current project remains open.')
    }
  }
  const openProject = async (file: File) => {
    try {
      let manifest
      let bundledMedia = new Map<string, Blob>()
      const archived = await isProjectArchive(file)
      if (archived) {
        const decoded = await decodeProjectArchive(file)
        manifest = decoded.manifest
        bundledMedia = decoded.media
      } else {
        manifest = parseProjectManifest(await file.text())
      }
      if (manifest.format !== 'kyrocut-project' || manifest.version !== 1 || !Array.isArray(manifest.media) || !Array.isArray(manifest.tracks)) {
        setNotice('This is not a supported KYROCUT X1 project file')
        return
      }
      const frameRate = manifest.frameRate?.numerator && manifest.frameRate?.denominator ? manifest.frameRate : SEQUENCE_FRAME_RATE
      let storageFailures = 0
      const restoredAssets = await Promise.all(manifest.media.map(async (asset) => {
        const bundled = bundledMedia.get(asset.id)
        if (bundled) {
          try { await saveMediaBlob(asset.id, bundled, asset.name) } catch { storageFailures += 1 }
        }
        const blob = bundled ?? await getMediaBlob(asset.id).catch(() => null)
        const url = blob ? URL.createObjectURL(blob) : ''
        if (url) objectUrls.current.push(url)
        return {
          id: asset.id, name: asset.name, kind: asset.kind, url,
          size: blob?.size ?? asset.size ?? 0,
          duration: framesToSeconds(asset.durationFrames ?? 0, frameRate),
          durationKnown: asset.durationFrames !== null,
          mimeType: blob?.type ?? asset.mimeType ?? '',
          missing: !blob,
        }
      }))
      setProjectFrameRate(frameRate)
      setProjectResolution(manifest.resolution)
      setAssets(restoredAssets)
      setTracks(manifest.tracks.map((track) => ({
        id: track.id, name: track.name, kind: track.kind, muted: Boolean(track.muted), locked: Boolean(track.locked),
        clips: track.clips.map((clip) => ({ id: clip.id, mediaId: clip.mediaId, start: framesToSeconds(clip.timelineStartFrame, frameRate), sourceIn: framesToSeconds(clip.sourceInFrame, frameRate), duration: framesToSeconds(clip.durationFrames, frameRate), enabled: clip.enabled })),
      })))
      setProjectId(manifest.id ?? createId())
      setProjectName(manifest.name || file.name.replace('.kcx1', ''))
      setPlayhead(framesToSeconds(manifest.playheadFrame ?? 0, frameRate))
      setSelectedClipId(null)
      setPlaying(false)
      const offline = restoredAssets.filter((asset) => !asset.url).length
      setNotice(archived
        ? offline
          ? `Opened portable project with ${bundledMedia.size} bundled media file(s). ${offline} source(s) still need relinking.`
          : `Opened portable project and restored ${bundledMedia.size} bundled media file(s).${storageFailures ? ' Browser storage could not retain every file; this session can still use them.' : ''}`
        : offline
          ? 'Opened legacy project manifest. Relink ' + offline + ' source media item(s) to preview them.'
          : 'Opened legacy project and restored matching media from browser storage.')
    } catch (error) {
      setNotice(error instanceof Error ? `Could not open project: ${error.message}` : 'Could not read this project file.')
    }
  }

  const relinkMedia = async (files: FileList | File[]) => {
    const candidates = Array.from(files)
    const updates = new Map<string, MediaAsset>()
    let storageFailures = 0
    for (const asset of missingAssets) {
      const file = candidates.find((candidate) => candidate.name.toLowerCase() === asset.name.toLowerCase() && mediaKind(candidate) === asset.kind)
      if (!file) continue
      try {
        await saveMediaBlob(asset.id, file, file.name)
      } catch {
        storageFailures += 1
      }
      const url = URL.createObjectURL(file)
      objectUrls.current.push(url)
      updates.set(asset.id, { ...asset, url, size: file.size, mimeType: file.type, missing: false })
    }
    if (updates.size) {
      setAssets((current) => current.map((item) => updates.get(item.id) ?? item))
      setNotice(storageFailures
        ? 'Relinked ' + updates.size + ' media item(s), but browser storage could not save ' + storageFailures + ' file(s).'
        : 'Relinked and stored ' + updates.size + ' media item(s) for future sessions.')
    } else {
      setNotice('No matching filenames found. Rename the source files or import them individually.')
    }
  }
  const stepPlayhead = (direction: -1 | 1) => {
    const frame = framesToSeconds(1, projectFrameRate)
    setPlaying(false)
    setPlayhead((current) => Math.max(0, Math.min(projectDuration, current + direction * frame)))
  }
  const togglePlayback = () => {
    if (!allClips.some((clip) => clip.enabled && clip.start <= playhead && playhead < clip.start + clip.duration)) {
      setNotice('Move the playhead onto an enabled timeline clip before playback')
      return
    }
    setPlaying((current) => !current)
  }
  const handleDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); void addFiles(event.dataTransfer.files) }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveProject()
        return
      }
      if (modifier && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        projectInput.current?.click()
        return
      }
      const target = event.target
      if (target instanceof HTMLElement && (
        target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'AUDIO', 'VIDEO'].includes(target.tagName)
      )) return
      if (event.code === 'Space') {
        event.preventDefault()
        togglePlayback()
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedClipId) {
          event.preventDefault()
          removeSelectedClip()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveProject, togglePlayback, removeSelectedClip, selectedClipId])

  return (
    <main className="kx-editor">
      <header className="kx-topbar">
        <a className="kx-brand" href="/" aria-label="KYROCUT X1 home"><span className="kx-brand-mark"><Clapperboard size={19} /></span><span>KYROCUT <b>X1</b></span></a>
        <div className="kx-project-title"><input aria-label="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} /><span className="kx-save-state">LOCAL PROJECT</span></div>
        <div className="kx-top-actions">
          <a className="kx-button kx-button-quiet" href="/compositor">Compositor</a>
          <button className="kx-button kx-button-quiet" onClick={() => projectInput.current?.click()}><FolderOpen size={15} /> Open</button>
          <input ref={projectInput} hidden type="file" accept=".kcx1,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void openProject(file); event.target.value = '' }} />
          <button className="kx-button kx-button-quiet" onClick={saveProject}><Save size={15} /> Save project</button>
          <button className="kx-button kx-button-primary" onClick={() => setNotice('Video rendering is not wired yet; the shared media renderer is the next engine milestone.')}><Sparkles size={15} /> Render</button>
        </div>
      </header>
      <div className="kx-menu-row"><span>File</span><span>Edit</span><span>Composition</span><span>Layer</span><span>Effects</span><span>Animation</span><span>View</span><span>Help</span><div className="kx-menu-spacer" /><span className="kx-version">X1 FOUNDATION BUILD</span></div>

      <section className="kx-workspace">
        <aside className="kx-panel kx-media-panel">
          <div className="kx-panel-heading">
            <div className="kx-tabs">
              <button className={activeTab === 'media' ? 'active' : ''} onClick={() => setActiveTab('media')}><FolderOpen size={14} /> Media</button>
              <button className={activeTab === 'effects' ? 'active' : ''} onClick={() => setActiveTab('effects')}><WandSparkles size={14} /> Effects</button>
              <button className={activeTab === 'text' ? 'active' : ''} onClick={() => setActiveTab('text')}><Layers3 size={14} /> Text</button>
            </div>
            <button className="kx-icon-button" title="Import media" onClick={() => fileInput.current?.click()}><Plus size={17} /></button>
            <input ref={fileInput} hidden multiple type="file" accept="video/*,audio/*,image/*" onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = '' }} />
          </div>
          {activeTab === 'media' && <div className="kx-media-content">
            <div className="kx-import-card" role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click() }} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
              <Upload size={21} /><strong>Import media</strong><span>Video, audio and image files</span>
            </div>
            <div className="kx-section-label">PROJECT ASSETS <span>{assets.length}</span></div>
            {missingAssets.length > 0 && <div className="kx-relink-box"><span>{missingAssets.length} OFFLINE SOURCE(S)</span><button onClick={() => relinkInput.current?.click()}>Relink media</button><input ref={relinkInput} hidden multiple type="file" accept="video/*,audio/*,image/*" onChange={(event) => { if (event.target.files) void relinkMedia(event.target.files); event.target.value = '' }} /></div>}
            {assets.length === 0 ? <div className="kx-empty-small"><ImagePlus size={23} /><span>Your imported media will appear here.</span></div> : <div className="kx-asset-list">
              {assets.map((asset) => <div className="kx-asset" key={asset.id}>
                <span className={`kx-asset-icon ${asset.kind}`}>{asset.kind === 'video' ? <Video size={16} /> : asset.kind === 'audio' ? <Music2 size={16} /> : <ImagePlus size={16} />}</span>
                <span className="kx-asset-copy"><strong>{asset.name}</strong><small>{asset.missing ? 'OFFLINE · RELINK REQUIRED' : asset.kind.toUpperCase() + ' · ' + asset.duration.toFixed(1) + 's'}</small></span>
                <button className="kx-add-asset" title="Add to timeline" onClick={() => addAssetToTimeline(asset)}><Plus size={15} /></button>
              </div>)}
            </div>}
          </div>}
          {activeTab === 'effects' && <div className="kx-inspector-content">
            {selectedClip ? <>
              <div className="kx-section-label">LIVE CLIP EFFECTS</div>
              <p className="kx-effect-note">These non-destructive adjustments are applied to the selected video or image preview and saved with the project.</p>
              <label className="kx-field"><span>Brightness · {selectedEffects.brightness}%</span><input type="range" min="0" max="200" value={selectedEffects.brightness} onChange={(event) => updateEffect({ brightness: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Contrast · {selectedEffects.contrast}%</span><input type="range" min="0" max="200" value={selectedEffects.contrast} onChange={(event) => updateEffect({ contrast: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Saturation · {selectedEffects.saturation}%</span><input type="range" min="0" max="200" value={selectedEffects.saturation} onChange={(event) => updateEffect({ saturation: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Blur · {selectedEffects.blur.toFixed(1)}px</span><input type="range" min="0" max="20" step="0.5" value={selectedEffects.blur} onChange={(event) => updateEffect({ blur: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Grayscale · {selectedEffects.grayscale}%</span><input type="range" min="0" max="100" value={selectedEffects.grayscale} onChange={(event) => updateEffect({ grayscale: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Sepia · {selectedEffects.sepia}%</span><input type="range" min="0" max="100" value={selectedEffects.sepia} onChange={(event) => updateEffect({ sepia: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Hue rotation · {selectedEffects.hueRotate}°</span><input type="range" min="0" max="360" value={selectedEffects.hueRotate} onChange={(event) => updateEffect({ hueRotate: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Opacity · {selectedEffects.opacity}%</span><input type="range" min="0" max="100" value={selectedEffects.opacity} onChange={(event) => updateEffect({ opacity: Number(event.target.value) })} /></label>
              <button onClick={() => updateSelectedClip({ effects: { ...DEFAULT_CLIP_EFFECTS } })}>Reset effects</button>
            </> : <div className="kx-empty-small"><WandSparkles size={22} /><span>Select a video or image clip to edit its live effects.</span></div>}
          </div>}
          {activeTab === 'text' && <div className="kx-text-tools">
            <div className="kx-section-label">CREATE GRAPHICS</div>
            <label className="kx-text-label" htmlFor="kx-title-text">TITLE CONTENT</label>
            <textarea id="kx-title-text" className="kx-title-input" rows={4} value={titleText} onChange={(event) => setTitleText(event.target.value)} placeholder="Type your title. Use a new line for multiple lines." />
            <button className="kx-button kx-button-primary kx-create-title" onClick={() => void createTextLayer()}><Plus size={13} /> Create title layer</button>
            <div className="kx-text-help"><strong>Vector title</strong><span>1920 × 1080 transparent SVG · 5-second clip · editable timeline position</span></div>
          </div>}
        </aside>

        <section className="kx-center-column">
          <div className="kx-preview-panel">
            <div className="kx-panel-title"><span>COMPOSITION VIEWER</span><span>{projectResolution.width} × {projectResolution.height} <i>·</i> {formatFrameRate(projectFrameRate)}</span></div>
            <div className="kx-preview-stage">
              {selectedAsset && !selectedAsset.url ? <div className="kx-preview-empty"><FolderOpen size={30} /><strong>MEDIA OFFLINE</strong><span>RELINK THE SOURCE FILE TO PREVIEW</span></div> : selectedAsset?.kind === 'video' ? <video ref={videoRef} style={{ filter: previewFilter, opacity: selectedEffects.opacity / 100 }} src={selectedAsset.url} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}  controls={false} /> :
                selectedAsset?.kind === 'image' ? <img style={{ filter: previewFilter, opacity: selectedEffects.opacity / 100 }} src={selectedAsset.url} alt={selectedAsset.name} /> :
                  selectedAsset?.kind === 'audio' ? <div className="kx-audio-preview"><AudioLines size={54} /><strong>{selectedAsset.name}</strong><span>Audio source preview</span><audio ref={audioRef} src={selectedAsset.url} controls onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => { if (selectedClip) { const elapsed = event.currentTarget.currentTime - selectedClip.sourceIn; const clamped = Math.min(selectedClip.duration, Math.max(0, elapsed)); setPlayhead(selectedClip.start + clamped); if (elapsed >= selectedClip.duration) { event.currentTarget.pause(); setPlaying(false) } } }} /></div> :
                    <div className="kx-preview-empty"><div className="kx-preview-logo"><Clapperboard size={32} /></div><strong>KYROCUT X1</strong><span>CREATIVE VIEWPORT</span><small>Select a clip to preview your composition</small></div>}
            </div>
            <div className="kx-transport">
              <button className="kx-icon-button" title="Previous frame" onClick={() => stepPlayhead(-1)}><StepBack size={15} /></button><button className="kx-icon-button" title="Play or pause" onClick={togglePlayback}>{playing ? <Pause size={17} /> : <Play size={17} />}</button><button className="kx-icon-button" title="Next frame" onClick={() => stepPlayhead(1)}><StepForward size={15} /></button>
              <span className="kx-timecode">{formatTime(playhead, projectFrameRate)}</span>
              <input aria-label="Timeline playhead" type="range" min="0" max={projectDuration} step={framesToSeconds(1, projectFrameRate)} value={Math.min(playhead, projectDuration)} onChange={(event) => setPlayhead(Number(event.target.value))} />
              <span className="kx-timecode">{formatTime(projectDuration, projectFrameRate)}</span>
              <button className="kx-icon-button" title="Viewer settings" onClick={() => setNotice('Viewer settings are reserved for playback quality and display controls.')}><Settings2 size={16} /></button>
            </div>
          </div>
          <div className="kx-timeline-panel">
            <div className="kx-timeline-toolbar">
              <div className="kx-timeline-label"><Scissors size={15} /><strong>TIMELINE</strong><span>SEQUENCE 01</span></div>
              <div className="kx-timeline-tools">
                <button onClick={() => addTrack('video')} title="Add video track"><Plus size={14} /> Video</button>
                <button onClick={() => addTrack('audio')} title="Add audio track"><Plus size={14} /> Audio</button>
                <button onClick={() => addTrack('graphics')} title="Add graphics track"><Plus size={14} /> Graphics</button>
                <button className="kx-icon-button" title="Timeline options" onClick={() => setNotice(`Timeline options: frame-accurate editing is enabled at ${formatFrameRate(projectFrameRate)}.`)}><ChevronDown size={15} /></button>
              </div>
            </div>
            <div className="kx-ruler-row"><div className="kx-track-gutter">TRACKS</div><div className="kx-ruler">
              {Array.from({ length: Math.ceil(projectDuration / 5) + 1 }, (_, index) => <span key={index} style={{ left: `${index * 5 * 12}px` }}>{formatTime(index * 5, projectFrameRate)}</span>)}
              <div className="kx-playhead" style={{ left: `${playhead * 12}px` }} />
            </div></div>
            <div className="kx-track-scroll">
              {tracks.map((track) => <div className="kx-track-row" key={track.id}>
                <div className="kx-track-gutter"><strong>{track.name}</strong><span>{track.kind.toUpperCase()}</span>
                  <button title={track.muted ? 'Unmute track' : 'Mute track'} onClick={() => setTracks((current) => current.map((item) => item.id === track.id ? { ...item, muted: !item.muted } : item))}><Volume2 size={12} /></button>
                  <button title={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => setTracks((current) => current.map((item) => item.id === track.id ? { ...item, locked: !item.locked } : item))}>{track.locked ? 'L' : 'U'}</button>
                </div>
                <div className="kx-track-lane" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const clipId = event.dataTransfer.getData('application/x-kyrocut-clip'); if (clipId) { const bounds = event.currentTarget.getBoundingClientRect(); moveClipOnTimeline(clipId, track.id, (event.clientX - bounds.left) / 12) } }}>
                  {track.clips.map((clip) => {
                    const asset = assets.find((item) => item.id === clip.mediaId)
                    return <button key={clip.id} draggable onDragStart={(event) => { event.dataTransfer.setData('application/x-kyrocut-clip', clip.id); event.dataTransfer.effectAllowed = 'move' }} className={`kx-clip ${track.kind} ${selectedClipId === clip.id ? 'selected' : ''} ${clip.enabled ? '' : 'disabled'}`} style={{ left: `${clip.start * 12}px`, width: `${Math.max(48, clip.duration * 12)}px` }} onClick={() => { setSelectedClipId(clip.id); setPlayhead(clip.start) }} title={asset?.name ?? 'Missing media'}>
                      <span className="kx-clip-wave">{track.kind === 'audio' ? '▂▅▃▇▂▆▃▅▂▇▃▅' : '▥ ▥ ▥ ▥ ▥ ▥'}</span><strong>{asset?.name ?? 'Offline media'}</strong>
                    </button>
                  })}
                  <div className="kx-playhead" style={{ left: `${playhead * 12}px` }} />
                </div>
              </div>)}
              <div className="kx-playhead-line" style={{ left: `calc(176px + ${playhead * 12}px)` }} />
            </div>
            <div className="kx-timeline-footer"><span>{tracks.length} TRACKS</span><span>{allClips.length} CLIPS</span><span>{assets.length} ASSETS</span><span className="kx-footer-spacer" /><span>{formatFrameRate(projectFrameRate)}</span></div>
          </div>
        </section>

        <aside className="kx-panel kx-inspector">
          <div className="kx-panel-title"><span>INSPECTOR</span><Settings2 size={15} /></div>
          {selectedClip && selectedAsset ? <div className="kx-inspector-content">
            <div className="kx-inspector-file"><span className={`kx-asset-icon ${selectedAsset.kind}`}>{selectedAsset.kind === 'video' ? <Film size={17} /> : selectedAsset.kind === 'audio' ? <Music2 size={17} /> : <ImagePlus size={17} />}</span><div><strong>{selectedAsset.name}</strong><small>{selectedAsset.kind.toUpperCase()} SOURCE</small></div></div>
            <div className="kx-section-label">TRANSFORM / TIMING</div>
            <label className="kx-field"><span>Timeline start (s)</span><input type="number" min="0" step={framesToSeconds(1, projectFrameRate)} value={selectedClip.start.toFixed(2)} onChange={(event) => updateSelectedClip({ start: Number(event.target.value) })} /></label>
            <label className="kx-field"><span>Source in (s)</span><input type="number" min="0" step={framesToSeconds(1, projectFrameRate)} value={selectedClip.sourceIn.toFixed(2)} onChange={(event) => updateSelectedClip({ sourceIn: Number(event.target.value) })} /></label>
            <label className="kx-field"><span>Duration (s)</span><input type="number" min="0.03" step={framesToSeconds(1, projectFrameRate)} value={selectedClip.duration.toFixed(2)} onChange={(event) => updateSelectedClip({ duration: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Clip enabled</span><input type="checkbox" checked={selectedClip.enabled} onChange={(event) => updateSelectedClip({ enabled: event.target.checked })} /></label>
            <div className="kx-trim-actions"><button onClick={splitSelectedClip}><Scissors size={13} /> Split</button><button onClick={() => updateSelectedClip({ sourceIn: selectedClip.sourceIn + 0.5, duration: selectedClip.duration - 0.5 })}><Minus size={13} /> Trim start</button><button onClick={() => updateSelectedClip({ duration: selectedClip.duration - 0.5 })}><Minus size={13} /> Trim end</button></div>
            <button className="kx-delete-clip" onClick={removeSelectedClip}><Trash2 size={14} /> Remove clip</button>
            <div className="kx-section-label">SOURCE DETAILS</div>
            <div className="kx-detail-row"><span>File size</span><strong>{(selectedAsset.size / (1024 * 1024)).toFixed(2)} MB</strong></div>
            <div className="kx-detail-row"><span>Frame rate</span><strong>{formatFrameRate(projectFrameRate)}</strong></div>
            <div className="kx-detail-row"><span>Track</span><strong>{selectedTrack?.name ?? '—'}</strong></div>
          </div> : <div className="kx-inspector-empty"><Settings2 size={25} /><strong>No selection</strong><span>Select a clip on the timeline to inspect its timing and source properties.</span></div>}
        </aside>
      </section>
      <footer className="kx-statusbar"><span className="kx-status-dot" /> {notice}<span className="kx-status-spacer" /> KYROCUT X1 <span>·</span> WEB EDITION <span>·</span> PROJECT FORMAT v1</footer>
    </main>
  )
}
