# KYROCUT X1 — Foundation Architecture

## Product boundary

KYROCUT X1 has two first-class clients:

- Web client: browser-native media access, preview, interaction and supported browser rendering.
- Desktop client: native media access, native GPU integration, local project storage and high-throughput rendering.

Neither client owns a separate project format. Both target the same versioned project contract. The native package links the Rust core; the browser currently uses a TypeScript validator for that contract. A WASM bridge is still required before both clients execute the same Rust edit engine.

## Repository boundaries

| Path | Responsibility |
| --- | --- |
| apps/web | Browser application and editor UI |
| apps/desktop | Native GPUI application |
| apps/api | Cloudflare-compatible API surface |
| crates/kyrocut-core | Platform-independent project and timeline domain |
| crates/kyrocut-audio | Decoded PCM mixing and DSP primitives |
| crates/kyrocut-render | Deterministic CPU RGBA compositing and blend modes |
| crates/media | Existing FFmpeg setup assets; not yet a complete media engine |

## Core design rules

1. Time is stored as integer frames and rational frame rates. Do not use floating-point seconds as the canonical timeline coordinate.
2. Project edits are non-destructive. Source media is referenced; clips store source-in, timeline-start and duration separately.
3. Project manifests are versioned and migrations must be explicit.
4. Media locators must be portable. Absolute workstation paths must not be required to open a project.
5. The web and desktop clients must share edit semantics, even when their decode/render implementations differ.
6. UI controls must not imply unsupported processing. A render action remains explicitly unavailable until a real render pipeline is integrated.
7. Cache files are disposable. Project metadata and source media references are authoritative.
8. Expensive media work must move off the UI thread and expose cancellation/progress.

## Engine layers

### Project and edit model

Owns project identity, resolution, rational frame rate, media references, tracks, clips, transactional edit commands, bounded undo/redo history, timeline-frame evaluation, frame-addressed scalar animation curves, validation, serialization, schema migrations and recovery snapshots.

### Media services

Owns media probing, stream metadata, demuxing, decoding, frame/audio scheduling, thumbnails, proxies and cache invalidation. FFmpeg is an implementation dependency, not the project model.

### Timeline evaluator

Maps timeline frame positions to active clips, source frames, track state, transitions and nested compositions. It must be deterministic and testable without a UI.

### Render graph

Represents source nodes, transforms, masks, effects, compositing and output targets. The first CPU RGBA compositor now provides source-over compositing, Normal/Multiply/Screen/Add blend modes, opacity and a transformed-layer path with position, scale, rotation and anchor using nearest-neighbour sampling. It operates on encoded RGBA8 channel values; masks, linear-light color management, GPU backends and video-frame integration remain future work.

### Animation evaluator

The core currently evaluates frame-addressed scalar curves with Hold, Linear, SmoothStep and cubic-Bezier interpolation. Property binding, vector/color curves, graph-editor UI and expression evaluation remain future work.

### Audio graph

The first audio crate provides validated interleaved PCM buffers, sample-accurate timeline clip mixing with source-in and duration boundaries, decibel gain, fades, stereo pan, peak and RMS metering. Compressed decoding, timeline scheduling, automation, effects, limiting and output-device integration remain future work.

### Client adapters

Translate UI gestures and native/browser events into shared edit commands. Platform-specific code must not fork project semantics. The browser-to-Rust WASM adapter and native GPUI panel wiring are not implemented yet.

## First vertical slice

The first useful end-to-end slice is:

1. Import local video, audio and image assets.
2. Inspect source metadata.
3. Place assets on tracks.
4. Select and adjust clip timing using integer-frame values.
5. Preview source media.
6. Save a versioned project manifest.
7. Reopen the project and relink source media.
8. Render a deterministic sequence through the shared render path.

The current web foundation implements local import, arrangement, selected-source preview, manifest save/open and basic filename-based media relinking. It does not yet implement a full timeline playback compositor, portable media packaging or final export.

## Validation gates

- Unit tests for frame arithmetic, clip boundaries, project validation and migrations.
- Integration tests for importing, arranging, saving and reopening projects.
- Browser tests for file import, selection, track operations and project download.
- Native tests for project loading and edit command behavior.
- Cross-platform CI for Linux, Windows and macOS.
- No milestone is complete based on a visual panel alone.
