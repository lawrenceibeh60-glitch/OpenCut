# KYROCUT X1 render primitives

The render crate provides deterministic CPU operations over straight-alpha RGBA8 buffers.

## Current operations

- Source-over compositing with Normal, Multiply, Screen, and Add blend modes.
- Position, anchor, scale, and rotation transforms with nearest-neighbour sampling.
- Layer opacity.
- SDR color controls: exposure, contrast, saturation, gamma, and brightness.
- Rectangular crop.
- Soft RGB chroma key with alpha preservation.

## Current limitations

These are foundational CPU operations, not a complete professional color pipeline. Color controls operate on display-encoded RGB values rather than a scene-linear, color-managed working space. Transform sampling is nearest-neighbour. There is no GPU render graph, mask system, temporal effect cache, optical-flow interpolation, or project-level effect/keyframe binding yet.
