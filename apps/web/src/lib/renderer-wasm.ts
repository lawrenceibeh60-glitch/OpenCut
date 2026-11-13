export type RendererWasm = {
  apply_color_adjustments_rgba(
    width: number,
    height: number,
    pixels: Uint8Array,
    exposureStops: number,
    contrast: number,
    saturation: number,
    gamma: number,
    brightness: number,
  ): Uint8Array
}

type GeneratedRendererModule = {
  default: () => Promise<unknown>
  apply_color_adjustments_rgba: RendererWasm['apply_color_adjustments_rgba']
}

let rendererPromise: Promise<RendererWasm | null> | undefined

/** Load the Rust renderer compiled by wasm-pack. A missing optional build is a safe null fallback. */
export function loadRendererWasm(): Promise<RendererWasm | null> {
  if (!rendererPromise) {
    rendererPromise = (async () => {
      try {
        const url = new URL('../generated/renderer-wasm/kyrocut_renderer.js', import.meta.url)
        const generated = await import(/* @vite-ignore */ url.href) as GeneratedRendererModule
        await generated.default()
        return { apply_color_adjustments_rgba: generated.apply_color_adjustments_rgba }
      } catch {
        return null
      }
    })()
  }
  return rendererPromise
}
