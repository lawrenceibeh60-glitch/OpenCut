# KYROCUT X1 media engine

This crate is the native FFmpeg boundary for source probing and bounded video-frame decoding.

## Native dependency setup

The repository pins an LGPL FFmpeg build in `setup/ffmpeg.json`. Install it before compiling the workspace:

```sh
bun run crates/media/setup/setup.ts
```

Then point the FFmpeg Rust binding at that installation:

```sh
# Linux example; adapt the directory name for the current host.
export FFMPEG_DIR="$PWD/.cache/media/ffmpeg-8.1.3-linux-x86_64"
cargo test -p kyrocut-media
```

The setup manifest and build recipe are the source of truth for the native libraries. Do not silently fall back to an arbitrary system FFmpeg: reproducible editor builds need a known FFmpeg ABI and codec configuration.

## Current API

- `probe(path)` reads container duration and the best video/audio stream properties.
- `decode_video_frames(path, max_frames)` decodes a bounded number of frames and returns owned RGBA8 buffers.
- `decode_video_frame_at(path, index)` retrieves a frame by presentation order (currently sequential from the start, not yet optimized random access).
- `decode_audio_f32_stereo(path)` decodes and resamples the best audio stream to 48 kHz stereo float PCM for `kyrocut-audio`.
- `mix_project_audio(project, media_audio)` places decoded audio clips on the project timeline, respects disabled clips and muted tracks, and converts rational project-frame positions to sample positions.
- `render_timeline_video_frame(project, frame, media_paths)` evaluates the shared Rust timeline, maps project frames to source frame rates, decodes active video/image sources, and composites them through `kyrocut-render`.

The decoder currently performs sequential decode from the beginning of the file. Timestamp/keyframe seeking, asynchronous decode queues, PTS-aware variable-frame-rate scheduling, proxy generation, real-time playback clock synchronization, and desktop/web engine integration remain outstanding. This crate is not yet the complete playback engine.
