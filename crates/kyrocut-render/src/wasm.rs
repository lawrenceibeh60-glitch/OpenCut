use wasm_bindgen::prelude::*;

use crate::{apply_color_adjustments_linear, ColorAdjustments, RgbaImage};

/// Apply deterministic linear-light color adjustments to an RGBA8 frame.
#[wasm_bindgen]
pub fn apply_color_adjustments_rgba(
    width: u32,
    height: u32,
    pixels: &[u8],
    exposure_stops: f32,
    contrast: f32,
    saturation: f32,
    gamma: f32,
    brightness: f32,
) -> Result<Vec<u8>, JsValue> {
    let image = RgbaImage::new(width, height, pixels.to_vec())
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let adjustments = ColorAdjustments {
        exposure_stops,
        contrast,
        saturation,
        gamma,
        brightness,
    };
    let output = apply_color_adjustments_linear(&image, adjustments)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    Ok(output.pixels().to_vec())
}
