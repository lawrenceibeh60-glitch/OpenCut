import { createFileRoute } from '@tanstack/react-router'
import { removeBackground } from '@bg0/browser'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { framesToSeconds, secondsToFrames, SEQUENCE_FRAME_RATE } from '../lib/timebase'
import type { RationalFrameRate } from '../lib/timebase'
import { parseProjectManifest, type ClipEffects, type ClipKeyframe, type ProjectManifest } from '../lib/project-format'
import { evaluateClipEffects } from '../lib/clip-animation'
import { inheritNullLayerTransform } from '../lib/null-layer'
import { parseCubeLut, type Lut3D } from '../lib/lut'
import { applyClipTrim } from '../lib/timeline-editing'
import { createWebGLCompositor, type WebGLCompositor } from '../lib/webgl-compositor'
import { getMediaBlob, saveMediaBlob } from '../lib/media-storage'
import { clampTimelineTime, getActivePlaybackClips, getPrimaryPreviewClip } from '../lib/timeline-playback'
import { decodeProjectArchive, encodeProjectArchive, isProjectArchive } from '../lib/project-archive'
import { CREATIVE_ASSET_SOURCES, CREATIVE_FONTS, CREATIVE_LUT_ASSETS, CREATIVE_PRESETS } from '../lib/creative-library'
import type { CreativePreset, CreativePresetKind } from '../lib/creative-library'
import {
  AudioLines, ChevronDown, Clapperboard, Film, FolderOpen, ImagePlus, Layers3,
  Minus, Music2, Pause, Play, Plus, Save, Scissors, Settings2, Sparkles, StepBack, StepForward, Trash2,
  Upload, Video, Volume2, WandSparkles,
} from 'lucide-react'
import './editor.css'
import './editor-extra.css'

export const Route = createFileRoute('/editor')({ component: Editor })

type MediaKind = 'video' | 'audio' | 'image' | 'null'
type MediaAsset = { id: string; name: string; kind: MediaKind; url: string; size: number; duration: number; durationKnown: boolean; mimeType: string; missing?: boolean }
type TimelineClip = { id: string; mediaId: string; start: number; sourceIn: number; duration: number; enabled: boolean; effects?: ClipEffects; keyframes?: ClipKeyframe[]; parentClipId?: string; lutId?: string; lutIntensity?: number }
type TimelineTrack = { id: string; name: string; kind: 'video' | 'audio' | 'graphics' | 'adjustment'; clips: TimelineClip[]; muted: boolean; locked: boolean }
type TrimDrag = { clipId: string; trackId: string; edge: 'left' | 'right'; startX: number; start: number; sourceIn: number; duration: number }

const createId = () => globalThis.crypto?.randomUUID?.() ?? `kyro-${Date.now()}-${Math.random().toString(16).slice(2)}`
const formatTime = (seconds: number, rate: RationalFrameRate = SEQUENCE_FRAME_RATE) => {
  const safe = Math.max(0, seconds)
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}:${String(Math.floor((safe % 1) * rate.numerator / rate.denominator)).padStart(2, '0')}`
}
const mediaKind = (file: File): MediaKind | null => file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : null
const formatFrameRate = (rate: RationalFrameRate) => `${Number((rate.numerator / rate.denominator).toFixed(3))} FPS`
const DEFAULT_CLIP_EFFECTS: ClipEffects = { volume: 100, blendMode: 'normal', brightness: 100, contrast: 100, saturation: 100, blur: 0, grayscale: 0, sepia: 0, hueRotate: 0, opacity: 100, positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, rotation: 0 }

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
  const [activeTab, setActiveTab] = useState<'media' | 'effects' | 'text' | 'library'>('media')
  const [titleText, setTitleText] = useState('YOUR TITLE')
  const [titleColor, setTitleColor] = useState('#ffffff')
  const [titleFontSize, setTitleFontSize] = useState(88)
  const [shapeColor, setShapeColor] = useState('#d6ad5c')
  const [titleFontFamily, setTitleFontFamily] = useState('Inter')
  const [librarySearch, setLibrarySearch] = useState('')
  const [loadedLuts, setLoadedLuts] = useState<Record<string, Lut3D>>({})
  const [libraryKind, setLibraryKind] = useState<'all' | CreativePresetKind>('all')
  const [backgroundRemovalBusy, setBackgroundRemovalBusy] = useState(false)
  const [backgroundRemovalProgress, setBackgroundRemovalProgress] = useState(0)
  const [ownedWatermarkConfirmed, setOwnedWatermarkConfirmed] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [showCompositionSettings, setShowCompositionSettings] = useState(false)
  const [trimDrag, setTrimDrag] = useState<TrimDrag | null>(null)
  const [projectName, setProjectName] = useState('Untitled project')
  const [projectId, setProjectId] = useState<string>(createId())
  const [projectFrameRate, setProjectFrameRate] = useState<RationalFrameRate>(SEQUENCE_FRAME_RATE)
  const [projectResolution, setProjectResolution] = useState({ width: 1920, height: 1080 })
  const [notice, setNotice] = useState('Import media to begin editing')
  const [recoveryReady, setRecoveryReady] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const relinkInput = useRef<HTMLInputElement>(null)
  const videoElementsRef = useRef(new Map<string, HTMLVideoElement>())
  const audioElementsRef = useRef(new Map<string, HTMLAudioElement>())
  const imageElementsRef = useRef(new Map<string, HTMLImageElement>())
  const exportCanvasRef = useRef<HTMLCanvasElement>(null)
  const gpuCompositorRef = useRef<WebGLCompositor | null>(null)
  const gpuFallbackRef = useRef(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const objectUrls = useRef<string[]>([])
  useEffect(() => () => objectUrls.current.forEach((url) => URL.revokeObjectURL(url)), [])
  useEffect(() => () => gpuCompositorRef.current?.dispose(), [])
  useEffect(() => {
    let active = true
    void Promise.all(CREATIVE_LUT_ASSETS.map(async (item) => {
      const response = await fetch('/assets/luts/' + encodeURIComponent(item.filename))
      if (!response.ok) throw new Error('Could not load ' + item.name)
      return [item.id, parseCubeLut(await response.text(), item.id)] as const
    })).then((entries) => {
      if (active) setLoadedLuts(Object.fromEntries(entries))
    }).catch((error) => {
      if (active) setNotice(error instanceof Error ? 'Some LUT files could not be loaded: ' + error.message : 'Some LUT files could not be loaded')
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(titleFontFamily).replace(/%20/g, '+')}:wght@400;700&display=swap`
    link.dataset.kyrocutFont = titleFontFamily
    document.head.appendChild(link)
    return () => link.remove()
  }, [titleFontFamily])

  useEffect(() => {
    if (!trimDrag) return
    const move = (event: PointerEvent) => {
      const deltaFrames = Math.round((event.clientX - trimDrag.startX) / 12 * projectFrameRate.numerator / projectFrameRate.denominator)
      const track = tracks.find((item) => item.id === trimDrag.trackId)
      const clip = track?.clips.find((item) => item.id === trimDrag.clipId)
      if (!track || !clip || track.locked) return
      const asset = assets.find((item) => item.id === clip.mediaId)
      const trimmed = applyClipTrim(
        { start: trimDrag.start, sourceIn: trimDrag.sourceIn, duration: trimDrag.duration },
        trimDrag.edge,
        deltaFrames,
        projectFrameRate,
        asset?.durationKnown ? asset.duration : undefined,
      )
      setTracks((current) => current.map((item) => item.id !== trimDrag.trackId ? item : {
        ...item,
        clips: item.clips.map((entry) => entry.id === trimDrag.clipId ? { ...entry, ...trimmed } : entry),
      }))
    }
    const finish = () => setTrimDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [trimDrag, projectFrameRate, tracks, assets])

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
                missing: asset.kind !== 'null' && !blob,
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
                duration: framesToSeconds(clip.durationFrames, frameRate), enabled: clip.enabled, effects: clip.effects, keyframes: clip.keyframes, parentClipId: clip.parentClipId, lutId: clip.lutId, lutIntensity: clip.lutIntensity,
              })),
            })))
            setProjectId(manifest.id ?? createId())
            setProjectName(manifest.name || 'Recovered project')
            setPlayhead(framesToSeconds(manifest.playheadFrame ?? 0, frameRate))
            const offline = restoredAssets.filter((asset) => asset.kind !== 'null' && !asset.url).length
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
  const activePlayback = useMemo(() => getActivePlaybackClips(tracks, playhead), [tracks, playhead])
  const activeVisualClips = useMemo(() => activePlayback.filter(({ track }) => track.kind === 'video' || track.kind === 'graphics'), [activePlayback])
  const activeAudioClips = useMemo(() => activePlayback.filter(({ track, clip }) => {
    const asset = assets.find((item) => item.id === clip.mediaId)
    return (track.kind === 'audio' && asset?.kind === 'audio') || (track.kind === 'video' && asset?.kind === 'video')
  }), [activePlayback, assets])
  const audioTimelineClips = useMemo(() => tracks.filter((track) => track.kind === 'audio' || track.kind === 'video')
    .flatMap((track) => track.clips.filter((clip) => {
      const asset = assets.find((item) => item.id === clip.mediaId)
      return asset?.kind === 'audio' || asset?.kind === 'video'
    })), [tracks, assets])
  useEffect(() => {
    const candidate = getPrimaryPreviewClip(activePlayback)
    if (candidate && candidate.clip.id !== selectedClipId) setSelectedClipId(candidate.clip.id)
    else if (!candidate && playing && selectedClipId) setSelectedClipId(null)
  }, [activePlayback, selectedClipId, playing])
  const selectedAsset = assets.find((asset) => asset.id === selectedClip?.mediaId) ?? null
  const projectDuration = Math.max(30, ...allClips.filter((clip) => clip.enabled).map((clip) => clip.start + clip.duration))
  const selectedTrack = tracks.find((track) => track.clips.some((clip) => clip.id === selectedClipId))
  const missingAssets = assets.filter((asset) => asset.kind !== 'null' && !asset.url)
  const filteredCreativePresets = CREATIVE_PRESETS.filter((preset) => (libraryKind === 'all' || preset.kind === libraryKind) && `${preset.name} ${preset.description}`.toLowerCase().includes(librarySearch.toLowerCase()))
  const selectedBaseEffects = selectedClip?.effects ?? DEFAULT_CLIP_EFFECTS
  const selectedFrame = selectedClip ? secondsToFrames(Math.max(0, playhead - selectedClip.start), projectFrameRate) : 0
  const getClipEffects = (clip: TimelineClip) => {
    let result = evaluateClipEffects(clip.effects ?? DEFAULT_CLIP_EFFECTS, clip.keyframes, secondsToFrames(Math.max(0, playhead - clip.start), projectFrameRate))
    let parentId = clip.parentClipId
    const visited = new Set([clip.id])
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId)
      const track = tracks.find((item) => item.clips.some((entry) => entry.id === parentId))
      const parent = track?.clips.find((entry) => entry.id === parentId)
      const asset = parent ? assets.find((item) => item.id === parent.mediaId) : undefined
      if (!parent || asset?.kind !== 'null' || !parent.enabled || track?.muted || playhead < parent.start || playhead >= parent.start + parent.duration) break
      const parentEffects = evaluateClipEffects(parent.effects ?? DEFAULT_CLIP_EFFECTS, parent.keyframes, secondsToFrames(Math.max(0, playhead - parent.start), projectFrameRate))
      result = inheritNullLayerTransform(result, parentEffects)
      parentId = parent.parentClipId
    }
    return result
  }
  const selectedEffects = evaluateClipEffects(selectedBaseEffects, selectedClip?.keyframes, selectedFrame)
  const updateEffect = (patch: Partial<ClipEffects>) => {
    const existingKeys = selectedClip?.keyframes ?? []
    let updatedKeyframe = false
    const keyframes = existingKeys.map((keyframe) => {
      if (keyframe.frame !== selectedFrame || !(keyframe.property in patch)) return keyframe
      const value = patch[keyframe.property]
      if (value === undefined) return keyframe
      updatedKeyframe = true
      return { ...keyframe, value }
    })
    updateSelectedClip({
      effects: { ...selectedBaseEffects, ...patch },
      ...(updatedKeyframe ? { keyframes } : {}),
    })
  }
  const addKeyframe = (property: ClipKeyframe['property']) => {
    if (!selectedClip) return
    const value = selectedEffects[property]
    const existing = selectedClip.keyframes ?? []
    const propertyKeys = existing.filter((keyframe) => keyframe.property === property)
    const match = propertyKeys.find((keyframe) => keyframe.frame === selectedFrame)
    const withBase = selectedFrame > 0 && (propertyKeys.length === 0 || propertyKeys[0].frame > 0)
      ? [...existing, { frame: 0, property, value: selectedBaseEffects[property], interpolation: 'linear' as const }]
      : existing
    const keyframe: ClipKeyframe = { frame: selectedFrame, property, value, interpolation: match?.interpolation ?? 'linear' }
    const keyframes = match
      ? withBase.map((item) => item.frame === match.frame && item.property === match.property ? keyframe : item)
      : [...withBase, keyframe].sort((a, b) => a.frame - b.frame)
    updateSelectedClip({ keyframes })
    setNotice(`Added ${property} keyframe at frame ${selectedFrame}`)
  }

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
        ...(clip.keyframes?.length ? { keyframes: clip.keyframes } : {}),
        ...(clip.parentClipId ? { parentClipId: clip.parentClipId } : {}),
        ...(clip.lutId ? { lutId: clip.lutId, lutIntensity: clip.lutIntensity ?? 1 } : {}),
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
    const activeVideoIds = new Set(activeVisualClips.filter(({ clip }) =>
      assets.some((asset) => asset.id === clip.mediaId && asset.kind === 'video'),
    ).map(({ clip }) => clip.id))
    for (const { clip } of activeVisualClips) {
      const asset = assets.find((item) => item.id === clip.mediaId)
      if (asset?.kind !== 'video') continue
      const media = videoElementsRef.current.get(clip.id)
      if (!media) continue
      const sourceTime = clip.sourceIn + Math.max(0, playhead - clip.start)
      const effects = getClipEffects(clip)
      media.volume = Math.min(1, Math.max(0, effects.volume / 100))
      if (!playing && Number.isFinite(sourceTime) && Math.abs(media.currentTime - sourceTime) > 0.04) {
        try { media.currentTime = sourceTime } catch { /* metadata may not be ready yet */ }
      }
      if (playing && media.paused) void media.play().catch(() => setPlaying(false))
      if (!playing && !media.paused) media.pause()
    }
    for (const [id, media] of videoElementsRef.current) {
      if (!activeVideoIds.has(id) && !media.paused) media.pause()
    }
  }, [activeVisualClips, assets, playhead, playing])

  useEffect(() => {
    const activeIds = new Set(activeAudioClips.map(({ clip }) => clip.id))
    for (const clip of audioTimelineClips) {
      const media = audioElementsRef.current.get(clip.id)
      if (!media) continue
      if (!activeIds.has(clip.id) || !playing) {
        if (!media.paused) media.pause()
        continue
      }
      const sourceTime = clip.sourceIn + Math.max(0, playhead - clip.start)
      const effects = getClipEffects(clip)
      media.volume = Math.min(1, Math.max(0, effects.volume / 100))
      if (Math.abs(media.currentTime - sourceTime) > 0.25) {
        try { media.currentTime = sourceTime } catch { /* metadata may not be ready yet */ }
      }
      if (media.paused) void media.play().catch(() => { /* video sources without audio tracks remain silent */ })
    }
  }, [activeAudioClips, audioTimelineClips, playhead, playing])

  const timelineDuration = Math.max(0, ...allClips.filter((clip) => clip.enabled).map((clip) => clip.start + clip.duration))
  useEffect(() => {
    if (!playing) return
    if (timelineDuration <= playhead) { setPlaying(false); return }
    let request = 0
    const startedAt = performance.now()
    const startTime = playhead
    const tick = (now: number) => {
      const next = clampTimelineTime(startTime + (now - startedAt) / 1000, timelineDuration)
      setPlayhead(next)
      if (next >= timelineDuration) {
        setPlaying(false)
        return
      }
      request = requestAnimationFrame(tick)
    }
    request = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(request)
  }, [playing, timelineDuration])

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
      : asset.kind === 'null'
        ? targetTrack.kind === 'adjustment'
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
      effects: selectedClip.effects, keyframes: selectedClip.keyframes, parentClipId: selectedClip.parentClipId, lutId: selectedClip.lutId, lutIntensity: selectedClip.lutIntensity,
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
    const removingNullController = assets.some((asset) => asset.id === selectedClip?.mediaId && asset.kind === 'null')
    setTracks((current) => current.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== selectedClipId).map((clip) => removingNullController && clip.parentClipId === selectedClipId ? { ...clip, parentClipId: undefined } : clip) })))
    setSelectedClipId(null)
    setNotice('Clip removed from timeline')
  }
  const removeOwnedWatermarkLayer = () => {
    if (!ownedWatermarkConfirmed) { setNotice('Confirm that you own this watermark or have permission to remove it'); return }
    if (selectedTrack?.kind !== 'graphics' || selectedAsset?.kind !== 'image') {
      setNotice('Select a separate image/logo overlay layer on a Graphics track. Embedded third-party marks are not removed.')
      return
    }
    removeSelectedClip()
    setOwnedWatermarkConfirmed(false)
    setNotice('Removed your selected watermark overlay layer. The source asset remains in the media bin.')
  }

  const addTrack = (kind: TimelineTrack['kind']) => {
    const prefix = kind === 'audio' ? 'A' : kind === 'graphics' ? 'G' : kind === 'adjustment' ? 'ADJ' : 'V'
    const number = tracks.filter((track) => track.kind === kind).length + 1
    setTracks((current) => [...current, { id: createId(), name: `${prefix}${number}`, kind, clips: [], muted: false, locked: false }])
  }
  const createNullLayer = () => {
    const asset: MediaAsset = { id: createId(), name: `Null Controller ${assets.filter((item) => item.kind === 'null').length + 1}`, kind: 'null', url: '', size: 0, duration: 30, durationKnown: true, mimeType: 'application/x-kyrocut-null' }
    const existing = tracks.find((track) => track.kind === 'adjustment' && !track.locked)
    const target = existing ?? { id: createId(), name: `ADJ${tracks.filter((track) => track.kind === 'adjustment').length + 1}`, kind: 'adjustment' as const, clips: [], muted: false, locked: false }
    const clip: TimelineClip = { id: createId(), mediaId: asset.id, start: playhead, sourceIn: 0, duration: 30, enabled: true, effects: { ...DEFAULT_CLIP_EFFECTS } }
    setAssets((current) => [...current, asset])
    if (!existing) setTracks((current) => [...current, target])
    setTracks((current) => current.map((track) => track.id === target.id ? { ...track, clips: [...track.clips, clip].sort((a, b) => a.start - b.start) } : track))
    setSelectedClipId(clip.id)
    setActiveTab('effects')
    setNotice(`Created ${asset.name}. Parent visual layers to it in the Inspector.`)
  }

  const applyCreativePreset = (preset: CreativePreset) => {
    if (!selectedClip) { setNotice('Select a timeline clip before applying a preset'); return }
    const currentEffects = selectedClip.effects ?? DEFAULT_CLIP_EFFECTS
    const nextEffects = preset.effects ? { ...currentEffects, ...preset.effects } : currentEffects
    const durationFrames = Math.max(1, secondsToFrames(selectedClip.duration, projectFrameRate))
    const generated: ClipKeyframe[] = (preset.motion ?? []).flatMap((motion) => {
      const span = Math.min(motion.frames, Math.max(0, durationFrames - 1))
      if (span <= 0) return []
      const firstFrame = motion.edge === 'in' ? 0 : durationFrames - span
      const lastFrame = motion.edge === 'in' ? span : durationFrames - 1
      return [
        { frame: firstFrame, property: motion.property, value: motion.from, interpolation: 'linear' as const },
        { frame: lastFrame, property: motion.property, value: motion.to, interpolation: 'linear' as const },
      ]
    })
    const merged = new Map<string, ClipKeyframe>()
    for (const keyframe of [...(selectedClip.keyframes ?? []), ...generated]) merged.set(`${keyframe.property}:${keyframe.frame}`, keyframe)
    updateSelectedClip({ effects: nextEffects, keyframes: [...merged.values()].sort((a, b) => a.frame - b.frame) })
    setNotice(`Applied ${preset.name} to ${selectedAsset?.name ?? 'selected layer'}`)
  }

  const downloadBundledLut = async (filename: string) => {
    try {
      const response = await fetch('/assets/luts/catalog.json')
      if (!response.ok) throw new Error('Could not load the bundled LUT catalog')
      const catalog = await response.json() as { luts: Array<{ filename: string; data: string }> }
      const lut = catalog.luts.find((item) => item.filename === filename)
      if (!lut) throw new Error('LUT file was not found in the bundled catalog')
      const url = URL.createObjectURL(new Blob([lut.data], { type: 'text/plain' }))
      const link = document.createElement('a')
      link.href = url
      link.download = lut.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice(`Downloaded ${filename}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not download LUT')
    }
  }

  const removeSelectedBackground = async () => {
    if (!selectedClip || selectedAsset?.kind !== 'image' || !selectedAsset.url || backgroundRemovalBusy) return
    setBackgroundRemovalBusy(true)
    setBackgroundRemovalProgress(0)
    try {
      const stored = await getMediaBlob(selectedAsset.id).catch(() => null)
      const original = stored ?? await fetch(selectedAsset.url).then((response) => {
        if (!response.ok) throw new Error('Could not read the selected image source')
        return response.blob()
      })
      if (original.size > 40 * 1024 * 1024) throw new Error('Background removal supports images up to 40 MB')
      const input = new File([original], selectedAsset.name, { type: original.type || selectedAsset.mimeType || 'image/png' })
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(input.type)) throw new Error('Use a PNG, JPEG or WebP image for AI background removal')
      const result = await removeBackground(input, {
        quality: 'quality',
        onProgress: ({ progress, message }) => {
          setBackgroundRemovalProgress(Math.round(progress * 100))
          setNotice(message || `Removing background · ${Math.round(progress * 100)}%`)
        },
      })
      const outputId = createId()
      const outputName = `${selectedAsset.name.split('.').slice(0, -1).join('.') || selectedAsset.name}-background-removed.png`
      await saveMediaBlob(outputId, result.blob, outputName)
      const url = URL.createObjectURL(result.blob)
      objectUrls.current.push(url)
      setAssets((current) => [...current, { id: outputId, name: outputName, kind: 'image', url, size: result.blob.size, duration: selectedAsset.duration, durationKnown: true, mimeType: 'image/png' }])
      setTracks((current) => current.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, mediaId: outputId } : clip) })))
      setNotice('Background removed locally. The original remains in the media bin.')
    } catch (error) {
      setNotice(error instanceof Error ? `Background removal failed: ${error.message}` : 'Background removal failed')
    } finally {
      setBackgroundRemovalBusy(false)
      setBackgroundRemovalProgress(0)
    }
  }

  const createTextLayer = async () => {
    const text = titleText.trim()
    if (!text) { setNotice('Enter some text before creating a title layer'); return }
    const xmlSafe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    const lines = xmlSafe.split(/\r?\n/)
    const lineHeight = 96
    const firstY = 540 - ((lines.length - 1) * lineHeight) / 2
    const tspans = lines.map((line, index) => `<tspan x="960" y="${firstY + index * lineHeight}">${line || ' '}</tspan>`).join('')
    const safeFont = titleFontFamily.replace(/["&<>]/g, '')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><text text-anchor="middle" dominant-baseline="middle" font-family="${safeFont}, Arial, Helvetica, sans-serif" font-size="${titleFontSize}" font-weight="700" letter-spacing="1" fill="${titleColor}" stroke="#111111" stroke-width="3" paint-order="stroke">${tspans}</text></svg>`
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
  const startExport = () => {
    const canvas = exportCanvasRef.current
    if (!canvas || timelineDuration <= 0) { setNotice('Add at least one enabled clip before exporting'); return }
    if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') {
      setNotice('This browser does not support WebM recording. Use a current desktop Chrome or Edge browser.')
      return
    }
    if (recorderRef.current?.state === 'recording') return
    canvas.width = projectResolution.width
    canvas.height = projectResolution.height
    if (!gpuCompositorRef.current && !gpuFallbackRef.current) {
      try {
        const gpu = createWebGLCompositor(canvas)
        if (gpu) gpuCompositorRef.current = gpu
        else if (canvas.getContext('2d')) gpuFallbackRef.current = true
        else { setNotice('Neither WebGL2 nor Canvas2D is available for export'); return }
      } catch (error) {
        setNotice(error instanceof Error ? 'GPU renderer initialization failed: ' + error.message : 'GPU renderer initialization failed')
        return
      }
    }
    const fps = Math.min(60, Math.max(1, projectFrameRate.numerator / projectFrameRate.denominator))
    const stream = canvas.captureStream(fps)
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((type) => MediaRecorder.isTypeSupported(type))
    let recorder: MediaRecorder
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop())
      setNotice(error instanceof Error ? 'Could not start export: ' + error.message : 'Could not start browser export')
      return
    }
    recordingChunksRef.current = []
    recorder.ondataavailable = (event) => { if (event.data.size > 0) recordingChunksRef.current.push(event.data) }
    recorder.onerror = () => {
      setNotice('Browser export failed while recording. Try a shorter sequence or lower resolution.')
      setIsExporting(false)
      setPlaying(false)
    }
    recorder.onstop = () => {
      const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'video/webm' })
      recordingChunksRef.current = []
      stream.getTracks().forEach((track) => track.stop())
      recorderRef.current = null
      setIsExporting(false)
      setPlaying(false)
      if (!blob.size) { setNotice('Export produced an empty file. Check that your browser can decode the source media.'); return }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = (projectName.trim().replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'kyrocut-export') + '.webm'
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
      setNotice('WebM export complete · ' + (blob.size / (1024 * 1024)).toFixed(1) + ' MB')
    }
    recorderRef.current = recorder
    setPlayhead(0)
    setIsExporting(true)
    setPlaying(true)
    requestAnimationFrame(() => {
      const audioSources: Array<HTMLAudioElement | HTMLVideoElement> = [
        ...audioTimelineClips.map((clip) => audioElementsRef.current.get(clip.id)).filter((item): item is HTMLAudioElement => Boolean(item)),
      ]
      const capturedAudio = new Set<string>()
      for (const source of audioSources) {
        const capturable = source as (HTMLAudioElement | HTMLVideoElement) & { captureStream?: () => MediaStream }
        const audioStream = capturable.captureStream?.()
        for (const track of audioStream?.getAudioTracks() ?? []) {
          if (!capturedAudio.has(track.id)) {
            stream.addTrack(track)
            capturedAudio.add(track.id)
          }
        }
      }
      try {
        recorder.start(250)
        setNotice('Recording composition to WebM…')
      } catch (error) {
        stream.getTracks().forEach((track) => track.stop())
        recorderRef.current = null
        setIsExporting(false)
        setPlaying(false)
        setNotice(error instanceof Error ? 'Could not start recording: ' + error.message : 'Could not start recording')
      }
    })
  }

  useEffect(() => {
    if (isExporting && !playing && recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }, [isExporting, playing])

  useEffect(() => {
    if (!isExporting) return
    const canvas = exportCanvasRef.current
    if (!canvas) return
    if (gpuCompositorRef.current) {
      const layers = [...getActivePlaybackClips(tracks, playhead)]
        .filter(({ track }) => track.kind === 'video' || track.kind === 'graphics')
        .reverse()
        .flatMap(({ clip }) => {
          const asset = assets.find((item) => item.id === clip.mediaId)
          const source = asset?.kind === 'video'
            ? videoElementsRef.current.get(clip.id)
            : asset?.kind === 'image' ? imageElementsRef.current.get(clip.id) : undefined
          if (!source) return []
          const effects = getClipEffects(clip)
          return [{ id: clip.id, source, effects, lut: clip.lutId ? loadedLuts[clip.lutId] : undefined, lutStrength: clip.lutIntensity ?? 1 }]
        })
      gpuCompositorRef.current.render(canvas.width, canvas.height, layers)
      return
    }
    const context = canvas.getContext('2d')
    if (!context) { setNotice('Canvas2D fallback is unavailable for export'); return }
    context.fillStyle = '#000000'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const layers = [...getActivePlaybackClips(tracks, playhead)]
      .filter(({ track }) => track.kind === 'video' || track.kind === 'graphics')
      .reverse()
    for (const { clip } of layers) {
      const asset = assets.find((item) => item.id === clip.mediaId)
      if (!asset?.url) continue
      const source = asset.kind === 'video'
        ? videoElementsRef.current.get(clip.id)
        : imageElementsRef.current.get(clip.id)
      if (!source) continue
      const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth
      const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight
      if (!width || !height || (source instanceof HTMLVideoElement && source.readyState < 2)) continue
      const scale = Math.min(canvas.width / width, canvas.height / height)
      const drawWidth = width * scale
      const drawHeight = height * scale
      const effects = getClipEffects(clip)
      context.save()
      context.globalAlpha = effects.opacity / 100
      context.globalCompositeOperation = effects.blendMode === 'add' ? 'lighter' : effects.blendMode === 'normal' ? 'source-over' : effects.blendMode
      context.filter = `brightness(${effects.brightness}%) contrast(${effects.contrast}%) saturate(${effects.saturation}%) blur(${effects.blur}px) grayscale(${effects.grayscale}%) sepia(${effects.sepia}%) hue-rotate(${effects.hueRotate}deg)`
      context.translate(canvas.width / 2 + canvas.width * effects.positionX / 100, canvas.height / 2 + canvas.height * effects.positionY / 100)
      context.rotate(effects.rotation * Math.PI / 180)
      context.scale(effects.scaleX, effects.scaleY)
      context.drawImage(source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
      context.restore()
    }
  }, [isExporting, tracks, assets, playhead, projectResolution, loadedLuts])

  const createShapeLayer = async (shape: 'rectangle' | 'ellipse') => {
    const geometry = shape === 'rectangle'
      ? '<rect x="510" y="330" width="900" height="420" rx="28" fill="' + shapeColor + '" />'
      : '<ellipse cx="960" cy="540" rx="430" ry="260" fill="' + shapeColor + '" />'
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">${geometry}</svg>`
    const file = new File([svg], `${shape}-${Date.now()}.svg`, { type: 'image/svg+xml' })
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
      setNotice(`Created ${shape} shape layer on ${target.name}`)
    } catch (error) {
      setNotice(error instanceof Error ? 'Could not save shape layer: ' + error.message : 'Could not save shape layer')
    }
  }
  const saveProject = async () => {
    try {
      const bundledMedia = new Map<string, Blob>()
      let unavailable = 0
      for (const asset of assets) {
        if (asset.kind === 'null') continue
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
          missing: asset.kind !== 'null' && !blob,
        }
      }))
      setProjectFrameRate(frameRate)
      setProjectResolution(manifest.resolution)
      setAssets(restoredAssets)
      setTracks(manifest.tracks.map((track) => ({
        id: track.id, name: track.name, kind: track.kind, muted: Boolean(track.muted), locked: Boolean(track.locked),
        clips: track.clips.map((clip) => ({ id: clip.id, mediaId: clip.mediaId, start: framesToSeconds(clip.timelineStartFrame, frameRate), sourceIn: framesToSeconds(clip.sourceInFrame, frameRate), duration: framesToSeconds(clip.durationFrames, frameRate), enabled: clip.enabled, effects: clip.effects, keyframes: clip.keyframes, parentClipId: clip.parentClipId, lutId: clip.lutId, lutIntensity: clip.lutIntensity })),
      })))
      setProjectId(manifest.id ?? createId())
      setProjectName(manifest.name || file.name.replace('.kcx1', ''))
      setPlayhead(framesToSeconds(manifest.playheadFrame ?? 0, frameRate))
      setSelectedClipId(null)
      setPlaying(false)
      const offline = restoredAssets.filter((asset) => asset.kind !== 'null' && !asset.url).length
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
          <button className="kx-button kx-button-quiet" onClick={() => setShowCompositionSettings((open) => !open)}><Settings2 size={14} /> Composition</button>
          <a className="kx-button kx-button-quiet" href="/compositor">Compositor</a>
          <button className="kx-button kx-button-quiet" onClick={() => projectInput.current?.click()}><FolderOpen size={15} /> Open</button>
          <input ref={projectInput} hidden type="file" accept=".kcx1,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void openProject(file); event.target.value = '' }} />
          <button className="kx-button kx-button-quiet" onClick={saveProject}><Save size={15} /> Save project</button>
          <button className="kx-button kx-button-primary" onClick={() => isExporting ? recorderRef.current?.stop() : startExport()}><Sparkles size={15} /> {isExporting ? 'Stop export' : 'Export WebM'}</button>
        </div>
      </header>
      {showCompositionSettings && <section className="kx-composition-settings">
        <div className="kx-composition-settings-head"><strong>COMPOSITION SETTINGS</strong><button className="kx-icon-button" onClick={() => setShowCompositionSettings(false)} aria-label="Close composition settings"><X size={14} /></button></div>
        <label>Resolution
          <select value={`${projectResolution.width}x${projectResolution.height}`} onChange={(event) => { const [width, height] = event.target.value.split('x').map(Number); setProjectResolution({ width, height }) }}>
            <option value="1280x720">1280 × 720 · HD</option>
            <option value="1920x1080">1920 × 1080 · Full HD</option>
            <option value="2560x1440">2560 × 1440 · QHD</option>
            <option value="3840x2160">3840 × 2160 · 4K UHD</option>
          </select>
        </label>
        <label>Frame rate
          <select value={`${projectFrameRate.numerator}/${projectFrameRate.denominator}`} onChange={(event) => { const [numerator, denominator] = event.target.value.split('/').map(Number); setProjectFrameRate({ numerator, denominator }) }}>
            <option value="24/1">24 FPS</option>
            <option value="25/1">25 FPS</option>
            <option value="30/1">30 FPS</option>
            <option value="50/1">50 FPS</option>
            <option value="60/1">60 FPS</option>
          </select>
        </label>
        <span>{projectResolution.width} × {projectResolution.height} · {formatFrameRate(projectFrameRate)}</span>
      </section>}
      <div className="kx-menu-row"><span>File</span><span>Edit</span><span>Composition</span><span>Layer</span><span>Effects</span><span>Animation</span><span>View</span><span>Help</span><div className="kx-menu-spacer" /><span className="kx-version">X1 FOUNDATION BUILD</span></div>

      <section className="kx-workspace">
        <aside className="kx-panel kx-media-panel">
          <div className="kx-panel-heading">
            <div className="kx-tabs">
              <button className={activeTab === 'media' ? 'active' : ''} onClick={() => setActiveTab('media')}><FolderOpen size={14} /> Media</button>
              <button className={activeTab === 'effects' ? 'active' : ''} onClick={() => setActiveTab('effects')}><WandSparkles size={14} /> Effects</button>
              <button className={activeTab === 'text' ? 'active' : ''} onClick={() => setActiveTab('text')}><Layers3 size={14} /> Text</button>
              <button className={activeTab === 'library' ? 'active' : ''} onClick={() => setActiveTab('library')}><Sparkles size={14} /> Library</button>
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
            <div className="kx-library-head"><div className="kx-section-label">CREATIVE PRESETS <span>{CREATIVE_PRESETS.length}</span></div><input aria-label="Search creative presets" value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} placeholder="Search presets…" /><select aria-label="Preset category" value={libraryKind} onChange={(event) => setLibraryKind(event.target.value as 'all' | CreativePresetKind)}><option value="all">All categories</option><option value="grade">Color grades</option><option value="transition">Transitions</option><option value="motion">Text / motion</option><option value="style">Visual styles</option></select></div>
            <div className="kx-preset-grid">{filteredCreativePresets.slice(0, 48).map((preset) => <article className="kx-preset-card" key={preset.id}><div className={`kx-preset-swatch ${preset.kind}`} /><div className="kx-preset-copy"><strong>{preset.name}</strong><small>{preset.description}</small></div><button disabled={!selectedClip} onClick={() => applyCreativePreset(preset)}>Apply</button></article>)}</div>
            {filteredCreativePresets.length > 48 && <p className="kx-effect-note">Showing 48 of {filteredCreativePresets.length} matches. Refine your search to find a preset.</p>}
            {selectedClip ? <>
              {selectedAsset?.kind === 'image' && <div className="kx-bg-remove-card"><div><strong>AI Background Removal</strong><small>Local processing · source image stays private</small></div><button disabled={backgroundRemovalBusy} onClick={() => void removeSelectedBackground()}>{backgroundRemovalBusy ? `Processing ${backgroundRemovalProgress}%` : 'Remove background'}</button></div>}
              <div className="kx-section-label">LIVE CLIP EFFECTS</div>
              <p className="kx-effect-note">These non-destructive adjustments are applied to the selected video or image preview and saved with the project.</p>
              <label className="kx-field"><span>Brightness · {selectedEffects.brightness}% <button type="button" className="kx-keyframe-button" title="Add or update brightness keyframe" onClick={() => addKeyframe('brightness')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'brightness') ? '◆' : '◇'}</button></span><input type="range" min="0" max="200" value={selectedEffects.brightness} onChange={(event) => updateEffect({ brightness: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Contrast · {selectedEffects.contrast}% <button type="button" className="kx-keyframe-button" title="Add or update contrast keyframe" onClick={() => addKeyframe('contrast')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'contrast') ? '◆' : '◇'}</button></span><input type="range" min="0" max="200" value={selectedEffects.contrast} onChange={(event) => updateEffect({ contrast: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Saturation · {selectedEffects.saturation}% <button type="button" className="kx-keyframe-button" title="Add or update saturation keyframe" onClick={() => addKeyframe('saturation')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'saturation') ? '◆' : '◇'}</button></span><input type="range" min="0" max="200" value={selectedEffects.saturation} onChange={(event) => updateEffect({ saturation: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Blur · {selectedEffects.blur.toFixed(1)}px <button type="button" className="kx-keyframe-button" title="Add or update blur keyframe" onClick={() => addKeyframe('blur')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'blur') ? '◆' : '◇'}</button></span><input type="range" min="0" max="20" step="0.5" value={selectedEffects.blur} onChange={(event) => updateEffect({ blur: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Grayscale · {selectedEffects.grayscale}% <button type="button" className="kx-keyframe-button" title="Add or update grayscale keyframe" onClick={() => addKeyframe('grayscale')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'grayscale') ? '◆' : '◇'}</button></span><input type="range" min="0" max="100" value={selectedEffects.grayscale} onChange={(event) => updateEffect({ grayscale: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Sepia · {selectedEffects.sepia}% <button type="button" className="kx-keyframe-button" title="Add or update sepia keyframe" onClick={() => addKeyframe('sepia')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'sepia') ? '◆' : '◇'}</button></span><input type="range" min="0" max="100" value={selectedEffects.sepia} onChange={(event) => updateEffect({ sepia: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Hue rotation · {selectedEffects.hueRotate}° <button type="button" className="kx-keyframe-button" title="Add or update hueRotate keyframe" onClick={() => addKeyframe('hueRotate')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'hueRotate') ? '◆' : '◇'}</button></span><input type="range" min="0" max="360" value={selectedEffects.hueRotate} onChange={(event) => updateEffect({ hueRotate: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Opacity · {selectedEffects.opacity}% <button type="button" className="kx-keyframe-button" title="Add or update opacity keyframe" onClick={() => addKeyframe('opacity')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'opacity') ? '◆' : '◇'}</button></span><input type="range" min="0" max="100" value={selectedEffects.opacity} onChange={(event) => updateEffect({ opacity: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Audio level · {selectedEffects.volume}% <button type="button" className="kx-keyframe-button" title="Add or update audio level keyframe" onClick={() => addKeyframe('volume')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'volume') ? '◆' : '◇'}</button></span><input type="range" min="0" max="200" value={selectedEffects.volume} onChange={(event) => updateEffect({ volume: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Blend mode</span><select value={selectedEffects.blendMode} onChange={(event) => updateEffect({ blendMode: event.target.value as ClipEffects['blendMode'] })}><option value="normal">Normal</option><option value="multiply">Multiply</option><option value="screen">Screen</option><option value="add">Add</option></select></label>
              <div className="kx-section-label">TRANSFORM</div>
              <label className="kx-field"><span>Position X · {selectedEffects.positionX}% <button type="button" className="kx-keyframe-button" title="Add or update positionX keyframe" onClick={() => addKeyframe('positionX')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'positionX') ? '◆' : '◇'}</button></span><input type="range" min="-100" max="100" value={selectedEffects.positionX} onChange={(event) => updateEffect({ positionX: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Position Y · {selectedEffects.positionY}% <button type="button" className="kx-keyframe-button" title="Add or update positionY keyframe" onClick={() => addKeyframe('positionY')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'positionY') ? '◆' : '◇'}</button></span><input type="range" min="-100" max="100" value={selectedEffects.positionY} onChange={(event) => updateEffect({ positionY: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Scale X · {selectedEffects.scaleX.toFixed(2)}× <button type="button" className="kx-keyframe-button" title="Add or update scaleX keyframe" onClick={() => addKeyframe('scaleX')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'scaleX') ? '◆' : '◇'}</button></span><input type="range" min="0.1" max="5" step="0.01" value={selectedEffects.scaleX} onChange={(event) => updateEffect({ scaleX: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Scale Y · {selectedEffects.scaleY.toFixed(2)}× <button type="button" className="kx-keyframe-button" title="Add or update scaleY keyframe" onClick={() => addKeyframe('scaleY')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'scaleY') ? '◆' : '◇'}</button></span><input type="range" min="0.1" max="5" step="0.01" value={selectedEffects.scaleY} onChange={(event) => updateEffect({ scaleY: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Rotation · {selectedEffects.rotation}° <button type="button" className="kx-keyframe-button" title="Add or update rotation keyframe" onClick={() => addKeyframe('rotation')}>{selectedClip.keyframes?.some((keyframe) => keyframe.frame === selectedFrame && keyframe.property === 'rotation') ? '◆' : '◇'}</button></span><input type="range" min="-180" max="180" value={selectedEffects.rotation} onChange={(event) => updateEffect({ rotation: Number(event.target.value) })} /></label>
              <button onClick={() => updateSelectedClip({ effects: { ...DEFAULT_CLIP_EFFECTS } })}>Reset effects</button>
            </> : <div className="kx-empty-small"><WandSparkles size={22} /><span>Select a video or image clip to edit its live effects.</span></div>}
          </div>}
          {activeTab === 'library' && <div className="kx-text-tools"><div className="kx-section-label">BUNDLED 3D LUT LIBRARY <span>{CREATIVE_LUT_ASSETS.length}</span></div><p className="kx-effect-note">15 downloadable .cube looks. Source collection: YahiaAngelo/Film-Luts · MIT license. The current renderer does not yet apply 3D LUTs.</p>{CREATIVE_LUT_ASSETS.map((lut) => <div className="kx-source-card" key={lut.filename}><span><strong>{lut.name}</strong><small>{lut.category} · .cube · MIT</small></span><button onClick={() => void downloadBundledLut(lut.filename)}>DOWNLOAD</button></div>)}<div className="kx-section-label">DOWNLOADABLE CREATIVE ASSET SOURCES</div><p className="kx-effect-note">Curated external libraries. Open a source to download their packs; check the license on each asset before use.</p>{CREATIVE_ASSET_SOURCES.map((source) => <a className="kx-source-card" href={source.url} target="_blank" rel="noreferrer" key={source.id}><span><strong>{source.name}</strong><small>{source.category} · {source.license}</small><small>{source.details}</small></span><b>OPEN ↗</b></a>)}<div className="kx-section-label">FONT COLLECTION</div><p className="kx-effect-note">Twenty curated families are available in the title builder. The Google Fonts family files load on demand.</p></div>}
          {activeTab === 'text' && <div className="kx-text-tools">
            <div className="kx-section-label">CREATE GRAPHICS</div>
            <label className="kx-field"><span>Font family</span><select value={titleFontFamily} onChange={(event) => setTitleFontFamily(event.target.value)}>{CREATIVE_FONTS.map((font) => <option key={font} value={font}>{font}</option>)}</select></label>
            <div className="kx-section-label">TITLE STYLES</div><div className="kx-title-presets">{[{name:'Cinematic',font:'Oswald',color:'#f4e7cf',size:104},{name:'Editorial',font:'Playfair Display',color:'#e7d5b2',size:96},{name:'Tech',font:'Roboto Mono',color:'#72d9ef',size:76},{name:'Minimal',font:'Inter',color:'#ffffff',size:82},{name:'Impact',font:'Anton',color:'#f5f0e6',size:128},{name:'Neon',font:'Montserrat',color:'#ff9cf5',size:88},{name:'Retro',font:'Bebas Neue',color:'#ffc36a',size:116},{name:'Luxury',font:'Cinzel',color:'#e7d0a2',size:92}].map((preset) => <button key={preset.name} onClick={() => { setTitleFontFamily(preset.font); setTitleColor(preset.color); setTitleFontSize(preset.size) }}>{preset.name}</button>)}</div>
            <label className="kx-text-label" htmlFor="kx-title-text">TITLE CONTENT</label>
            <textarea id="kx-title-text" className="kx-title-input" rows={4} value={titleText} onChange={(event) => setTitleText(event.target.value)} placeholder="Type your title. Use a new line for multiple lines." />
            <label className="kx-shape-color">TEXT COLOUR <input type="color" value={titleColor} onChange={(event) => setTitleColor(event.target.value)} /></label>
            <label className="kx-field"><span>Font size · {titleFontSize}px</span><input type="range" min="24" max="180" step="2" value={titleFontSize} onChange={(event) => setTitleFontSize(Number(event.target.value))} /></label>
            <button className="kx-button kx-button-primary kx-create-title" onClick={() => void createTextLayer()}><Plus size={13} /> Create title layer</button>
            <div className="kx-text-help"><strong>Vector title</strong><span>1920 × 1080 transparent SVG · 5-second clip · editable timeline position</span></div>
            <div className="kx-section-label">SHAPE LAYERS</div>
            <label className="kx-shape-color">FILL COLOUR <input type="color" value={shapeColor} onChange={(event) => setShapeColor(event.target.value)} /></label>
            <div className="kx-shape-buttons">
              <button className="kx-button" onClick={() => void createShapeLayer('rectangle')}>Rectangle</button>
              <button className="kx-button" onClick={() => void createShapeLayer('ellipse')}>Ellipse</button>
            </div>
          </div>}
        </aside>

        <section className="kx-center-column">
          <div className="kx-preview-panel">
            <div className="kx-panel-title"><span>COMPOSITION VIEWER</span><span>{projectResolution.width} × {projectResolution.height} <i>·</i> {formatFrameRate(projectFrameRate)}</span></div>
            <div className="kx-preview-stage">
              {activeVisualClips.length > 0 ? [...activeVisualClips].reverse().map(({ clip }) => {
                const asset = assets.find((item) => item.id === clip.mediaId)
                const effects = getClipEffects(clip)
                const filter = `brightness(${effects.brightness}%) contrast(${effects.contrast}%) saturate(${effects.saturation}%) blur(${effects.blur}px) grayscale(${effects.grayscale}%) sepia(${effects.sepia}%) hue-rotate(${effects.hueRotate}deg)`
                if (!asset?.url) return <div className="kx-preview-offline" key={clip.id}><FolderOpen size={20} /> {asset?.name ?? 'MEDIA OFFLINE'} — RELINK SOURCE</div>
                const layerIndex = activeVisualClips.findIndex((item) => item.clip.id === clip.id)
                return asset.kind === 'video'
                  ? <video key={clip.id} className="kx-composition-layer" ref={(element) => { if (element) videoElementsRef.current.set(clip.id, element); else videoElementsRef.current.delete(clip.id) }} src={asset.url} style={{ filter, opacity: effects.opacity / 100, transform: `translate(${effects.positionX}%, ${effects.positionY}%) scale(${effects.scaleX}, ${effects.scaleY}) rotate(${effects.rotation}deg)`, mixBlendMode: effects.blendMode === 'add' ? 'plus-lighter' : effects.blendMode, zIndex: activeVisualClips.length - layerIndex }} muted playsInline preload="auto" />
                  : <img key={clip.id} className="kx-composition-layer" ref={(element) => { if (element) imageElementsRef.current.set(clip.id, element); else imageElementsRef.current.delete(clip.id) }} src={asset.url} alt={asset.name} style={{ filter, opacity: effects.opacity / 100, transform: `translate(${effects.positionX}%, ${effects.positionY}%) scale(${effects.scaleX}, ${effects.scaleY}) rotate(${effects.rotation}deg)`, mixBlendMode: effects.blendMode === 'add' ? 'plus-lighter' : effects.blendMode, zIndex: activeVisualClips.length - layerIndex }} />
              }) : activeAudioClips.length > 0 ? <div className="kx-audio-preview"><AudioLines size={54} /><strong>{activeAudioClips.map(({ clip }) => assets.find((asset) => asset.id === clip.mediaId)?.name ?? 'Audio').join(' + ')}</strong><span>Timeline audio mix</span></div> :
                selectedAsset && !selectedAsset.url ? <div className="kx-preview-empty"><FolderOpen size={30} /><strong>MEDIA OFFLINE</strong><span>RELINK THE SOURCE FILE TO PREVIEW</span></div> :
                <div className="kx-preview-empty"><div className="kx-preview-logo"><Clapperboard size={32} /></div><strong>KYROCUT X1</strong><span>CREATIVE VIEWPORT</span><small>Move the playhead over a layer to preview the composition</small></div>}
              <canvas ref={exportCanvasRef} className="kx-export-canvas" aria-hidden="true" />
              {audioTimelineClips.map((clip) => {
                const asset = assets.find((item) => item.id === clip.mediaId)
                return asset?.url && (asset.kind === 'audio' || asset.kind === 'video') ? <audio key={clip.id} ref={(element) => { if (element) audioElementsRef.current.set(clip.id, element); else audioElementsRef.current.delete(clip.id) }} src={asset.url} preload="auto" aria-hidden="true" /> : null
              })}
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
                <button onClick={createNullLayer} title="Create an invisible transform controller"><Plus size={14} /> Null</button>
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
                    return <button key={clip.id} draggable={!track.locked} onDragStart={(event) => { event.dataTransfer.setData('application/x-kyrocut-clip', clip.id); event.dataTransfer.effectAllowed = 'move' }} className={`kx-clip ${track.kind} ${selectedClipId === clip.id ? 'selected' : ''} ${clip.enabled ? '' : 'disabled'}`} style={{ left: `${clip.start * 12}px`, width: `${Math.max(48, clip.duration * 12)}px` }} onClick={() => { setSelectedClipId(clip.id); setPlayhead(clip.start) }} title={asset?.name ?? 'Missing media'}>
                      {!track.locked && <span className="kx-trim-handle left" role="presentation" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); setTrimDrag({ clipId: clip.id, trackId: track.id, edge: 'left', startX: event.clientX, start: clip.start, sourceIn: clip.sourceIn, duration: clip.duration }) }} />}
                      <span className="kx-clip-wave">{asset?.kind === 'null' ? '◇ NULL CONTROLLER' : track.kind === 'audio' ? '▂▅▃▇▂▆▃▅▂▇▃▅' : '▥ ▥ ▥ ▥ ▥ ▥'}</span><strong>{asset?.name ?? 'Offline media'}</strong>
                      {clip.keyframes?.map((keyframe, index) => <span key={`${keyframe.property}-${keyframe.frame}-${index}`} className="kx-keyframe-marker" style={{ left: `${framesToSeconds(keyframe.frame, projectFrameRate) * 12}px` }} title={`${keyframe.property} · frame ${keyframe.frame}`} aria-hidden="true">◆</span>)}
                      {!track.locked && <span className="kx-trim-handle right" role="presentation" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); setTrimDrag({ clipId: clip.id, trackId: track.id, edge: 'right', startX: event.clientX, start: clip.start, sourceIn: clip.sourceIn, duration: clip.duration }) }} />}
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
            <div className="kx-inspector-file"><span className={`kx-asset-icon ${selectedAsset.kind}`}>{selectedAsset.kind === 'video' ? <Film size={17} /> : selectedAsset.kind === 'audio' ? <Music2 size={17} /> : selectedAsset.kind === 'null' ? <Layers3 size={17} /> : <ImagePlus size={17} />}</span><div><strong>{selectedAsset.name}</strong><small>{selectedAsset.kind.toUpperCase()} SOURCE</small></div></div>
            <div className="kx-section-label">TRANSFORM / TIMING</div>
            {(selectedAsset.kind === 'video' || selectedAsset.kind === 'image') && <label className="kx-field"><span>Parent null layer</span><select value={selectedClip.parentClipId ?? ''} onChange={(event) => updateSelectedClip({ parentClipId: event.target.value || undefined })}><option value="">No parent</option>{allClips.filter((candidate) => candidate.id !== selectedClip.id && assets.some((asset) => asset.id === candidate.mediaId && asset.kind === 'null')).map((candidate) => <option key={candidate.id} value={candidate.id}>{assets.find((asset) => asset.id === candidate.mediaId)?.name ?? 'Null layer'}</option>)}</select></label>}
            {selectedAsset.kind === 'null' && <p className="kx-effect-note">Invisible controller. Animate its transform, then parent visual layers to it to move them together.</p>}
            <label className="kx-field"><span>Timeline start (s)</span><input type="number" min="0" step={framesToSeconds(1, projectFrameRate)} value={selectedClip.start.toFixed(2)} onChange={(event) => updateSelectedClip({ start: Number(event.target.value) })} /></label>
            <label className="kx-field"><span>Source in (s)</span><input type="number" min="0" step={framesToSeconds(1, projectFrameRate)} value={selectedClip.sourceIn.toFixed(2)} onChange={(event) => updateSelectedClip({ sourceIn: Number(event.target.value) })} /></label>
            <label className="kx-field"><span>Duration (s)</span><input type="number" min="0.03" step={framesToSeconds(1, projectFrameRate)} value={selectedClip.duration.toFixed(2)} onChange={(event) => updateSelectedClip({ duration: Number(event.target.value) })} /></label>
              <label className="kx-field"><span>Clip enabled</span><input type="checkbox" checked={selectedClip.enabled} onChange={(event) => updateSelectedClip({ enabled: event.target.checked })} /></label>
            <div className="kx-trim-actions"><button onClick={splitSelectedClip}><Scissors size={13} /> Split</button><button onClick={() => updateSelectedClip({ sourceIn: selectedClip.sourceIn + 0.5, duration: selectedClip.duration - 0.5 })}><Minus size={13} /> Trim start</button><button onClick={() => updateSelectedClip({ duration: selectedClip.duration - 0.5 })}><Minus size={13} /> Trim end</button></div>
            <button className="kx-delete-clip" onClick={removeSelectedClip}><Trash2 size={14} /> Remove clip</button>
            {selectedTrack?.kind === 'graphics' && selectedAsset.kind === 'image' && <div className="kx-watermark-tool"><strong>OWNED WATERMARK / LOGO LAYER</strong><label><input type="checkbox" checked={ownedWatermarkConfirmed} onChange={(event) => setOwnedWatermarkConfirmed(event.target.checked)} /> I own this mark or have permission to remove it.</label><button disabled={!ownedWatermarkConfirmed} onClick={removeOwnedWatermarkLayer}>Remove selected overlay</button><small>This removes a separate overlay layer only. It does not erase marks embedded in someone else’s footage.</small></div>}
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
