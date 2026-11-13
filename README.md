# KYROCUT X1

**A cross-platform creative production system for video editing, compositing, motion graphics and 3D.**

KYROCUT X1 is being developed as a shared creative platform with a browser editor and a native desktop application. Both editions target one versioned project contract and a shared Rust core. The native package links the core; the browser currently validates the same contract in TypeScript. A WASM bridge is still needed before the browser executes the Rust edit engine directly.

> This repository is an active foundation build. The web edition currently contains an early interactive editing workspace for importing local media, arranging clips on tracks, previewing selected source media, adjusting clip timing and saving a versioned project manifest. Native rendering, full timeline playback, effects processing, audio mixing, compositing and 3D are not yet complete. UI surfaces are not presented as implemented engine features.

## Product editions

- **Web:** React 19, TypeScript, Vite and TanStack Start. Runs in a modern browser and uses browser media APIs for the initial import and source-preview workflow.
- **Desktop:** Rust and GPUI. Intended for native media access, higher-throughput processing and platform GPU integration.
- **Shared engine:** Rust crates for frame-accurate project, media and timeline domain logic.

## Current foundation

- Shared Rust core crate: rational frame-rate handling, frame/time conversion, media references, tracks, clips, project duration, deterministic timeline evaluation, validation, Serde JSON project documents, transactional edit commands and bounded undo/redo history, and frame-addressed scalar animation curves with Hold, Linear, SmoothStep and cubic-Bezier interpolation.
- CPU render crate: RGBA8 image buffers, straight-alpha source-over compositing, opacity, Normal/Multiply/Screen/Add blend modes and transformed layers with position/scale/rotation, with unit tests.
- Audio DSP crate: validated interleaved PCM buffers, sample-accurate timeline clip mixing, source-in trimming, decibel gain, frame-accurate fades, equal-power stereo pan, peak and RMS metering.
- Web editor: local media import, media bin, video/image source preview, track creation, clip placement and drag-to-move, frame-snapped splitting, clip enable/disable, basic timing adjustments, track mute/lock flags, editor keyboard shortcuts, .kcx1 project save/open and filename-based source-media relinking, and strict project-manifest validation before opening.
- Browser rational timebase and project-manifest validation utilities with Vitest coverage for integer/fractional frame rates, malformed files and source-media bounds.
- Product identity, custom SVG marks, browser icon and PWA manifest for KYROCUT X1.
- Desktop application identity updated and linked to the shared project, CPU render and PCM audio crates.

## Planned engine modules

1. Project model, serialization and migrations
2. Media probing, demuxing, decoding and frame scheduling
3. Timeline evaluation and edit commands
4. Preview compositor and render graph
5. Keyframe and animation evaluation
6. Audio graph and mixing
7. Color pipeline and scopes
8. GPU effects and 2D/3D rendering
9. Export, render queue and delivery presets
10. Plugin and scripting APIs

The pinned FFmpeg build configuration in this repository is an upstream starting point, not a complete media engine integration. Its current configure flags must be reviewed before enabling filters, device capture, networking or other optional components.

## Development

Install the toolchain pinned in .prototools:

```sh
proto use
```

Run the browser app:

```sh
moon run web:dev
```

Run the API:

```sh
moon run api:dev
```

Run the desktop app:

```sh
moon run desktop:dev
```

Check and test the shared Rust core:

```sh
cargo check -p kyrocut-core
cargo test -p kyrocut-core
cargo check -p kyrocut-render
cargo test -p kyrocut-render
```

Build the web app:

```sh
moon run web:build
```

## Project manifest

The web foundation exports a .kcx1 project manifest using the kyrocut-project format identifier and version 1. It stores project settings, track structure, clip timing and portable media locators. Media binaries are deliberately not embedded in the JSON manifest. The browser foundation includes basic filename-based relinking; portable asset packaging and cross-platform round-trip tests are still required before project interchange is production-ready.

## Upstream

KYROCUT X1 began from the open-source OpenCut rewrite. The original project is available at https://github.com/OpenCut-app/OpenCut. Existing MIT licensing and applicable upstream notices are retained. KYROCUT X1 is an independent product direction and is not affiliated with the original maintainers.

## License

MIT. See LICENSE.


## Temporary browser workspaces

The web editor does not require user accounts. Each editor page load creates a new isolated workspace session with an opaque in-memory bearer token. Project manifests are autosaved to Neon Postgres under a hash of that session token, while imported media is uploaded to a session-specific prefix in the configured S3-compatible bucket. Neither the token nor unsaved project data is stored in browser localStorage or IndexedDB.

Sessions have a 2-hour idle expiry and are refreshed while the editor is active. The browser attempts to delete the session and its media when the page is closed or refreshed; expired sessions are also cleaned up when a new workspace is created. If the browser or device exits unexpectedly, the idle expiry prevents the old session from being resumed. The web editor deliberately does not restore a previous session after refresh.

Use **Export Draft** to download a portable `.kcx1` archive containing the project manifest and available media. Use **Import Draft** to continue from that archive later. Export Video produces the rendered video separately. Keep the downloaded draft somewhere safe; the online workspace is temporary.

Configure these variables as private Render environment variables on the web service (never commit their values):

- `DATABASE_URL_POOLED` (preferred for runtime queries) and `DATABASE_URL` (fallback)
- `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`, `S3_BUCKET`

The API creates the `kyrocut_workspace_sessions` table and expiry index automatically. It does not create user accounts or a permanent project library.
