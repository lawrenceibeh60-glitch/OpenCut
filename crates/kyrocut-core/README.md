# KYROCUT X1 Core

The core crate owns platform-independent project data and deterministic editing primitives. It must not depend on a windowing system, GPU API, FFmpeg runtime, or browser APIs.

## Compositing graph document

`CompositingGraph` is the portable graph representation shared by the desktop and web clients.

- Nodes have stable IDs, an operation kind, and typed input/output sockets.
- Connections reference node and socket IDs rather than array positions.
- Socket types currently include image, mask, scalar, 2D vector, and color.
- A graph must contain an Output node.
- Every input accepts at most one incoming connection. Multi-input operations should expose explicitly numbered or named sockets.
- Graphs are validated before serialization or execution planning.
- `execution_order()` returns a deterministic topological order and rejects cycles.

The graph document is intentionally separate from pixel execution. A render backend will evaluate this same validated document using CPU or GPU resources; the graph model itself stays backend-neutral.

## Animation data

Scalar keyframe curves are serializable and use integer project-frame positions. Supported interpolation modes are Hold, Linear, SmoothStep, and cubic Bézier. Curves validate finite values, strictly increasing frame positions, and monotonic Bézier time handles.

## Current boundaries

This crate currently provides data contracts, validation, timeline primitives, edit commands, history, and graph execution planning. It does not yet implement a node editor UI, GPU graph scheduler, effect kernels, masks/rotoscoping, or project-level binding of every clip property to an animation curve.
