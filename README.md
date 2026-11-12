# KYROCUT X1

**A cross-platform creative production system for video editing, compositing, motion graphics and 3D.**

KYROCUT X1 is being developed as a shared creative platform with a browser editor and a native desktop application. Both editions are designed around one project model and a shared Rust core so projects and editing semantics can remain portable across platforms.

> This repository is an active foundation build. The web edition currently contains an early interactive editing workspace for importing local media, arranging clips on tracks, previewing selected source media, adjusting clip timing and saving a versioned project manifest. Native rendering, full timeline playback, effects processing, audio mixing, compositing and 3D are not yet complete. UI surfaces are not presented as implemented engine features.

## Product editions

- **Web:** React 19, TypeScript, Vite and TanStack Start. Runs in a modern browser and uses browser media APIs for the initial import and source-preview workflow.
- **Desktop:** Rust and GPUI. Intended for native media access, higher-throughput processing and platform GPU integration.
- **Shared engine:** Rust crates for frame-accurate project, media and timeline domain logic.

## Current foundation

- Shared Rust core crate: rational frame-rate handling, frame/time conversion, media references, tracks, clips, project duration, deterministic timeline evaluation, validation, Serde JSON project documents, transactional edit commands and bounded undo/redo history, and frame-addressed scalar animation curves with Hold, Linear, SmoothStep and cubic-Bezier interpolation.
- CPU render crate: RGBA8 image buffers, straight-alpha source-over compositing, opacity and Normal/Multiply/Screen/Add blend modes, with unit tests.
- Web editor: local media import, media bin, video/image source preview, track creation, clip placement, clip selection, basic timing adjustments, track mute/lock flags, .kcx1 project save/open and filename-based source-media relinking, and strict project-manifest validation before opening.
- Browser rational timebase and project-manifest validation utilities with Vitest coverage for integer/fractional frame rates, malformed files and source-media bounds.
- Product identity, custom SVG marks, browser icon and PWA manifest for KYROCUT X1.
- Desktop application identity updated and wired to the shared core crate.

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
