//! Deterministic CPU compositing primitives.
//!
//! Pixels are stored as straight-alpha RGBA8. Blend math currently operates
//! directly on normalized channel values; a linear-light color pipeline is a
//! separate, explicitly planned engine layer.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlendMode {
    Normal,
    Multiply,
    Screen,
    Add,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pixels: Vec<u8>,
}

impl RgbaImage {
    pub fn new(width: u32, height: u32, pixels: Vec<u8>) -> Result<Self, RenderError> {
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(RenderError::InvalidDimensions)?;
        if width == 0 || height == 0 || pixels.len() != expected {
            return Err(RenderError::InvalidBufferLength {
                expected,
                actual: pixels.len(),
            });
        }
        Ok(Self { width, height, pixels })
    }

    pub fn transparent(width: u32, height: u32) -> Result<Self, RenderError> {
        let length = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(RenderError::InvalidDimensions)?;
        Self::new(width, height, vec![0; length])
    }

    pub fn solid(width: u32, height: u32, rgba: [u8; 4]) -> Result<Self, RenderError> {
        let length = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(RenderError::InvalidDimensions)?;
        let mut pixels = Vec::with_capacity(length);
        for _ in 0..(width as usize * height as usize) {
            pixels.extend_from_slice(&rgba);
        }
        Self::new(width, height, pixels)
    }

    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    pub fn pixel(&self, x: u32, y: u32) -> Option<[u8; 4]> {
        if x >= self.width || y >= self.height {
            return None;
        }
        let index = ((y as usize * self.width as usize) + x as usize) * 4;
        Some([
            self.pixels[index],
            self.pixels[index + 1],
            self.pixels[index + 2],
            self.pixels[index + 3],
        ])
    }
}

pub struct CompositeLayer<'a> {
    pub image: &'a RgbaImage,
    pub opacity: f32,
    pub blend_mode: BlendMode,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RenderError {
    InvalidDimensions,
    InvalidBufferLength { expected: usize, actual: usize },
    LayerDimensionsMismatch,
    InvalidOpacity,
}

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDimensions => write!(f, "image dimensions are invalid or overflow addressable memory"),
            Self::InvalidBufferLength { expected, actual } => write!(f, "RGBA buffer length mismatch: expected {expected}, got {actual}"),
            Self::LayerDimensionsMismatch => write!(f, "all compositor layers must match the output dimensions"),
            Self::InvalidOpacity => write!(f, "layer opacity must be finite and between 0 and 1"),
        }
    }
}

impl std::error::Error for RenderError {}

/// Composite layers from bottom to top using straight-alpha source-over math.
pub fn composite(
    width: u32,
    height: u32,
    layers: &[CompositeLayer<'_>],
) -> Result<RgbaImage, RenderError> {
    let mut output = RgbaImage::transparent(width, height)?;
    for layer in layers {
        if layer.image.width != width || layer.image.height != height {
            return Err(RenderError::LayerDimensionsMismatch);
        }
        if !layer.opacity.is_finite() || !(0.0..=1.0).contains(&layer.opacity) {
            return Err(RenderError::InvalidOpacity);
        }
        if layer.opacity == 0.0 {
            continue;
        }
        for (destination, source) in output.pixels.chunks_exact_mut(4).zip(layer.image.pixels.chunks_exact(4)) {
            blend_pixel(destination, source, layer.opacity, layer.blend_mode);
        }
    }
    Ok(output)
}

fn blend_pixel(destination: &mut [u8], source: &[u8], opacity: f32, mode: BlendMode) {
    let source_alpha = source[3] as f32 / 255.0 * opacity;
    let destination_alpha = destination[3] as f32 / 255.0;
    let output_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);

    if output_alpha <= f32::EPSILON {
        destination.fill(0);
        return;
    }

    for channel in 0..3 {
        let source_channel = source[channel] as f32 / 255.0;
        let destination_channel = destination[channel] as f32 / 255.0;
        let blended = match mode {
            BlendMode::Normal => source_channel,
            BlendMode::Multiply => source_channel * destination_channel,
            BlendMode::Screen => 1.0 - (1.0 - source_channel) * (1.0 - destination_channel),
            BlendMode::Add => (source_channel + destination_channel).min(1.0),
        };
        let premultiplied = (1.0 - source_alpha) * destination_alpha * destination_channel
            + (1.0 - destination_alpha) * source_alpha * source_channel
            + source_alpha * destination_alpha * blended;
        destination[channel] = ((premultiplied / output_alpha).clamp(0.0, 1.0) * 255.0).round() as u8;
    }

    destination[3] = (output_alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_top_layer_replaces_bottom_layer() {
        let background = RgbaImage::solid(1, 1, [0, 0, 255, 255]).unwrap();
        let foreground = RgbaImage::solid(1, 1, [255, 0, 0, 255]).unwrap();
        let result = composite(1, 1, &[
            CompositeLayer { image: &background, opacity: 1.0, blend_mode: BlendMode::Normal },
            CompositeLayer { image: &foreground, opacity: 1.0, blend_mode: BlendMode::Normal },
        ]).unwrap();
        assert_eq!(result.pixel(0, 0), Some([255, 0, 0, 255]));
    }

    #[test]
    fn half_opacity_source_over_opaque_background_blends_channels() {
        let background = RgbaImage::solid(1, 1, [0, 0, 255, 255]).unwrap();
        let foreground = RgbaImage::solid(1, 1, [255, 0, 0, 255]).unwrap();
        let result = composite(1, 1, &[
            CompositeLayer { image: &background, opacity: 1.0, blend_mode: BlendMode::Normal },
            CompositeLayer { image: &foreground, opacity: 0.5, blend_mode: BlendMode::Normal },
        ]).unwrap();
        assert_eq!(result.pixel(0, 0), Some([128, 0, 127, 255]));
    }

    #[test]
    fn transparent_pixel_does_not_change_output() {
        let background = RgbaImage::solid(1, 1, [10, 20, 30, 255]).unwrap();
        let transparent = RgbaImage::solid(1, 1, [255, 255, 255, 0]).unwrap();
        let result = composite(1, 1, &[
            CompositeLayer { image: &background, opacity: 1.0, blend_mode: BlendMode::Normal },
            CompositeLayer { image: &transparent, opacity: 1.0, blend_mode: BlendMode::Normal },
        ]).unwrap();
        assert_eq!(result.pixel(0, 0), Some([10, 20, 30, 255]));
    }

    #[test]
    fn multiply_blend_mode_combines_source_and_destination() {
        let background = RgbaImage::solid(1, 1, [255, 255, 255, 255]).unwrap();
        let foreground = RgbaImage::solid(1, 1, [80, 120, 200, 255]).unwrap();
        let result = composite(1, 1, &[
            CompositeLayer { image: &background, opacity: 1.0, blend_mode: BlendMode::Normal },
            CompositeLayer { image: &foreground, opacity: 1.0, blend_mode: BlendMode::Multiply },
        ]).unwrap();
        assert_eq!(result.pixel(0, 0), Some([80, 120, 200, 255]));
    }

    #[test]
    fn rejects_mismatched_layer_dimensions() {
        let layer = RgbaImage::solid(2, 2, [0, 0, 0, 255]).unwrap();
        assert_eq!(
            composite(1, 1, &[CompositeLayer { image: &layer, opacity: 1.0, blend_mode: BlendMode::Normal }]),
            Err(RenderError::LayerDimensionsMismatch)
        );
    }

    #[test]
    fn rejects_invalid_opacity() {
        let layer = RgbaImage::solid(1, 1, [0, 0, 0, 255]).unwrap();
        assert_eq!(
            composite(1, 1, &[CompositeLayer { image: &layer, opacity: f32::NAN, blend_mode: BlendMode::Normal }]),
            Err(RenderError::InvalidOpacity)
        );
    }
}
