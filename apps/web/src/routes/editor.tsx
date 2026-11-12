import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines, ChevronDown, Clapperboard, Film, FolderOpen, ImagePlus, Layers3,
  Minus, Music2, Pause, Play, Plus, Save, Scissors, Settings2, Sparkles, Trash2,
  Upload, Video, Volume2, WandSparkles,
} from 'lucide-react'
import './editor.css'

export const Route = createFileRoute('/editor')({ component: Editor })

type MediaKind = 'video' | 'audio' | 'image'
type MediaAsset = { id: string; name: string; kind: MediaKind; url: string; size: number; duration: number; mimeType: string }
type TimelineClip = { id: string; mediaId: string; start: number; sourceIn: number; duration: number }
type TimelineTrack = { id: string; name: string; kind: 'video' | 'audio' | 'graphics'; clips: TimelineClip[]; muted: boolean; locked: boolean }

const createId = () => globalThis.crypto?.randomUUID?.() ?? `kyro-${Date.now()}-${Math.random().toString(16).slice(2)}`
const formatTime = (seconds: number) => {
  const safe = Math.max(0, seconds)
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}:${String(Math.floor((safe % 1) * 30)).padStart(2, '0')}`
}
const mediaKind = (file: File): MediaKind | null => file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : null

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
  const [projectName, setProjectName] = useState('Untitled project')
  const [notice, setNotice] = useState('Import media to begin editing')
  const fileInput = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const objectUrls = useRef<string[]>([])
  useEffect(() => () => objectUrls.current.forEach((url) => URL.revokeObjectURL(url)), [])

  const allClips = useMemo(() => tracks.flatMap((track) => track.clips.map((clip) => ({ ...clip, trackId: track.id }))), [tracks])
  const selectedClip = allClips.find((clip) => clip.id === selectedClipId) ?? null
  const selectedAsset = assets.find((asset) => asset.id === selectedClip?.mediaId) ?? null
  const projectDuration = Math.max(30, ...allClips.map((clip) => clip.start + clip.duration))
  const selectedTrack = tracks.find((track) => track.clips.some((clip) => clip.id === selectedClipId))

  useEffect(() => {
    const sourceTime = selectedClip ? selectedClip.sourceIn + Math.max(0, playhead - selectedClip.start) : 0
    if (videoRef.current && selectedAsset?.kind === 'video') videoRef.current.currentTime = sourceTime
    if (audioRef.current && selectedAsset?.kind === 'audio') audioRef.current.currentTime = sourceTime
  }, [selectedAsset?.id, selectedClip?.id, playhead])

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const accepted = Array.from(files).filter((file) => mediaKind(file))
    if (!accepted.length) { setNotice('Choose a video, audio or image file'); return }
    const additions: MediaAsset[] = []
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
      const assetUrl = URL.createObjectURL(file)
      objectUrls.current.push(assetUrl)
      additions.push({ id: createId(), name: file.name, kind, url: assetUrl, size: file.size, duration: duration || 8, mimeType: file.type })
    }
    setAssets((current) => [...current, ...additions])
    setNotice(`Imported ${additions.length} media item${additions.length === 1 ? '' : 's'}`)
  }, [])

  const addAssetToTimeline = (asset: MediaAsset) => {
    const targetKind = asset.kind === 'audio' ? 'audio' : 'video'
    let target = tracks.find((track) => track.kind === targetKind && !track.locked)
    if (!target) {
      const id = createId()
      target = { id, name: `${targetKind === 'audio' ? 'A' : 'V'}${tracks.filter((track) => track.kind === targetKind).length + 1}`, kind: targetKind, clips: [], muted: false, locked: false }
      setTracks((current) => [...current, target!])
    }
    const clip: TimelineClip = { id: createId(), mediaId: asset.id, start: playhead, sourceIn: 0, duration: Math.max(1, asset.duration) }
    setTracks((current) => current.map((track) => track.id === target!.id ? { ...track, clips: [...track.clips, clip] } : track))
    setSelectedClipId(clip.id)
    setNotice(`Added ${asset.name} to ${target.name}`)
  }

  const updateSelectedClip = (patch: Partial<TimelineClip>) => {
    if (!selectedClipId) return
    setTracks((current) => current.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => clip.id === selectedClipId ? {
        ...clip, ...patch,
        duration: Math.max(0.25, patch.duration ?? clip.duration),
        start: Math.max(0, patch.start ?? clip.start),
        sourceIn: Math.max(0, patch.sourceIn ?? clip.sourceIn),
      } : clip),
    })))
  }
  const removeSelectedClip = () => {
    if (!selectedClipId) return
    setTracks((current) => current.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== selectedClipId) })))
    setSelectedClipId(null)
    setNotice('Clip removed from timeline')
  }
  const addTrack = (kind: TimelineTrack['kind']) => {
    const prefix = kind === 'audio' ? 'A' : kind === 'graphics' ? 'G' : 'V'
    const number = tracks.filter((track) => track.kind === kind).length + 1
    setTracks((current) => [...current, { id: createId(), name: `${prefix}${number}`, kind, clips: [], muted: false, locked: false }])
  }
  const saveProject = () => {
    const project = {
      format: 'kyrocut-project', version: 1, application: 'KYROCUT X1', name: projectName,
      frameRate: { numerator: 30, denominator: 1 }, resolution: { width: 1920, height: 1080 },
      media: assets.map(({ id, name, kind, size, duration, mimeType }) => ({ id, name, kind, size, durationFrames: Math.round(duration * 30), mimeType, locator: `media/${name}` })),
      tracks: tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ id: clip.id, mediaId: clip.mediaId, timelineStartFrame: Math.round(clip.start * 30), sourceInFrame: Math.round(clip.sourceIn * 30), durationFrames: Math.max(1, Math.round(clip.duration * 30)) })) })),
      playheadFrame: Math.round(playhead * 30),
    }
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${projectName.trim().replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'kyrocut-project'}.kcx1`
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice('Project file saved. Media files remain separate and can be relinked when reopened.')
  }
  const togglePlayback = () => {
    if (!selectedClip || !selectedAsset) { setNotice('Select a timeline clip to preview it'); return }
    if (selectedAsset.kind === 'video' && videoRef.current) {
      if (playing) videoRef.current.pause()
      else void videoRef.current.play()
    } else if (selectedAsset.kind === 'audio' && audioRef.current) {
      if (playing) audioRef.current.pause()
      else void audioRef.current.play()
    }
    if (selectedAsset.kind === 'image') { setNotice('Still image selected. Add it to a composition or move the playhead.'); return }
    setPlaying((value) => !value)
  }
  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); void addFiles(event.dataTransfer.files) }

  return (
    <main className="kx-editor">
      <header className="kx-topbar">
        <a className="kx-brand" href="/" aria-label="KYROCUT X1 home"><span className="kx-brand-mark"><Clapperboard size={19} /></span><span>KYROCUT <b>X1</b></span></a>
        <div className="kx-project-title"><input aria-label="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} /><span className="kx-save-state">LOCAL PROJECT</span></div>
        <div className="kx-top-actions">
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
            {assets.length === 0 ? <div className="kx-empty-small"><ImagePlus size={23} /><span>Your imported media will appear here.</span></div> : <div className="kx-asset-list">
              {assets.map((asset) => <div className="kx-asset" key={asset.id}>
                <span className={`kx-asset-icon ${asset.kind}`}>{asset.kind === 'video' ? <Video size={16} /> : asset.kind === 'audio' ? <Music2 size={16} /> : <ImagePlus size={16} />}</span>
                <span className="kx-asset-copy"><strong>{asset.name}</strong><small>{asset.kind.toUpperCase()} · {asset.duration.toFixed(1)}s</small></span>
                <button className="kx-add-asset" title="Add to timeline" onClick={() => addAssetToTimeline(asset)}><Plus size={15} /></button>
              </div>)}
            </div>}
          </div>}
          {activeTab === 'effects' && <div className="kx-placeholder-list"><strong>Effects library</strong><p>Effect processing is being connected to the shared render graph. No fake effects are exposed in this build.</p></div>}
          {activeTab === 'text' && <div className="kx-placeholder-list"><strong>Graphics and titles</strong><p>Text and shape layers will use the same timeline and keyframe model as media clips.</p></div>}
        </aside>

        <section className="kx-center-column">
          <div className="kx-preview-panel">
            <div className="kx-panel-title"><span>COMPOSITION VIEWER</span><span>1920 × 1080 <i>·</i> 30 FPS</span></div>
            <div className="kx-preview-stage">
              {selectedAsset?.kind === 'video' ? <video ref={videoRef} src={selectedAsset.url} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => { if (selectedClip) setPlayhead(selectedClip.start + event.currentTarget.currentTime - selectedClip.sourceIn) }} controls={false} /> :
                selectedAsset?.kind === 'image' ? <img src={selectedAsset.url} alt={selectedAsset.name} /> :
                  selectedAsset?.kind === 'audio' ? <div className="kx-audio-preview"><AudioLines size={54} /><strong>{selectedAsset.name}</strong><span>Audio source preview</span><audio ref={audioRef} src={selectedAsset.url} controls onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => { if (selectedClip) setPlayhead(selectedClip.start + event.currentTarget.currentTime - selectedClip.sourceIn) }} /></div> :
                    <div className="kx-preview-empty"><div className="kx-preview-logo"><Clapperboard size={32} /></div><strong>KYROCUT X1</strong><span>CREATIVE VIEWPORT</span><small>Select a clip to preview your composition</small></div>}
            </div>
            <div className="kx-transport">
              <button className="kx-icon-button" title="Play or pause" onClick={togglePlayback}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
              <span className="kx-timecode">{formatTime(playhead)}</span>
              <input aria-label="Timeline playhead" type="range" min="0" max={projectDuration} step="0.01" value={Math.min(playhead, projectDuration)} onChange={(event) => setPlayhead(Number(event.target.value))} />
              <span className="kx-timecode">{formatTime(projectDuration)}</span>
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
                <button className="kx-icon-button" title="Timeline options" onClick={() => setNotice('Timeline options: frame-accurate editing is enabled at 30 FPS.')}><ChevronDown size={15} /></button>
              </div>
            </div>
            <div className="kx-ruler-row"><div className="kx-track-gutter">TRACKS</div><div className="kx-ruler">
              {Array.from({ length: Math.ceil(projectDuration / 5) + 1 }, (_, index) => <span key={index} style={{ left: `${index * 5 * 12}px` }}>{formatTime(index * 5)}</span>)}
              <div className="kx-playhead" style={{ left: `${playhead * 12}px` }} />
            </div></div>
            <div className="kx-track-scroll">
              {tracks.map((track) => <div className="kx-track-row" key={track.id}>
                <div className="kx-track-gutter"><strong>{track.name}</strong><span>{track.kind.toUpperCase()}</span>
                  <button title={track.muted ? 'Unmute track' : 'Mute track'} onClick={() => setTracks((current) => current.map((item) => item.id === track.id ? { ...item, muted: !item.muted } : item))}><Volume2 size={12} /></button>
                  <button title={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => setTracks((current) => current.map((item) => item.id === track.id ? { ...item, locked: !item.locked } : item))}>{track.locked ? 'L' : 'U'}</button>
                </div>
                <div className="kx-track-lane">
                  {track.clips.map((clip) => {
                    const asset = assets.find((item) => item.id === clip.mediaId)
                    return <button key={clip.id} className={`kx-clip ${track.kind} ${selectedClipId === clip.id ? 'selected' : ''}`} style={{ left: `${clip.start * 12}px`, width: `${Math.max(48, clip.duration * 12)}px` }} onClick={() => { setSelectedClipId(clip.id); setPlayhead(clip.start) }} title={asset?.name ?? 'Missing media'}>
                      <span className="kx-clip-wave">{track.kind === 'audio' ? '▂▅▃▇▂▆▃▅▂▇▃▅' : '▥ ▥ ▥ ▥ ▥ ▥'}</span><strong>{asset?.name ?? 'Offline media'}</strong>
                    </button>
                  })}
                  <div className="kx-playhead" style={{ left: `${playhead * 12}px` }} />
                </div>
              </div>)}
              <div className="kx-playhead-line" style={{ left: `calc(176px + ${playhead * 12}px)` }} />
            </div>
            <div className="kx-timeline-footer"><span>{tracks.length} TRACKS</span><span>{allClips.length} CLIPS</span><span>{assets.length} ASSETS</span><span className="kx-footer-spacer" /><span>30 FPS</span></div>
          </div>
        </section>

        <aside className="kx-panel kx-inspector">
          <div className="kx-panel-title"><span>INSPECTOR</span><Settings2 size={15} /></div>
          {selectedClip && selectedAsset ? <div className="kx-inspector-content">
            <div className="kx-inspector-file"><span className={`kx-asset-icon ${selectedAsset.kind}`}>{selectedAsset.kind === 'video' ? <Film size={17} /> : selectedAsset.kind === 'audio' ? <Music2 size={17} /> : <ImagePlus size={17} />}</span><div><strong>{selectedAsset.name}</strong><small>{selectedAsset.kind.toUpperCase()} SOURCE</small></div></div>
            <div className="kx-section-label">TRANSFORM / TIMING</div>
            <label className="kx-field"><span>Timeline start (s)</span><input type="number" min="0" step="0.01" value={selectedClip.start.toFixed(2)} onChange={(event) => updateSelectedClip({ start: Number(event.target.value) })} /></label>
            <label className="kx-field"><span>Source in (s)</span><input type="number" min="0" step="0.01" value={selectedClip.sourceIn.toFixed(2)} onChange={(event) => updateSelectedClip({ sourceIn: Number(event.target.value) })} /></label>
            <label className="kx-field"><span>Duration (s)</span><input type="number" min="0.25" step="0.01" value={selectedClip.duration.toFixed(2)} onChange={(event) => updateSelectedClip({ duration: Number(event.target.value) })} /></label>
            <div className="kx-trim-actions"><button onClick={() => updateSelectedClip({ sourceIn: selectedClip.sourceIn + 0.5, duration: selectedClip.duration - 0.5 })}><Minus size={13} /> Trim start</button><button onClick={() => updateSelectedClip({ duration: selectedClip.duration - 0.5 })}><Minus size={13} /> Trim end</button></div>
            <button className="kx-delete-clip" onClick={removeSelectedClip}><Trash2 size={14} /> Remove clip</button>
            <div className="kx-section-label">SOURCE DETAILS</div>
            <div className="kx-detail-row"><span>File size</span><strong>{(selectedAsset.size / (1024 * 1024)).toFixed(2)} MB</strong></div>
            <div className="kx-detail-row"><span>Frame rate</span><strong>30 FPS sequence</strong></div>
            <div className="kx-detail-row"><span>Track</span><strong>{selectedTrack?.name ?? '—'}</strong></div>
          </div> : <div className="kx-inspector-empty"><Settings2 size={25} /><strong>No selection</strong><span>Select a clip on the timeline to inspect its timing and source properties.</span></div>}
        </aside>
      </section>
      <footer className="kx-statusbar"><span className="kx-status-dot" /> {notice}<span className="kx-status-spacer" /> KYROCUT X1 <span>·</span> WEB EDITION <span>·</span> PROJECT FORMAT v1</footer>
    </main>
  )
}
