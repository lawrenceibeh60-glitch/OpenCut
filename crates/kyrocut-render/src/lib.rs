//! Deterministic CPU compositing primitives.
//!
//! Pixels are stored as straight-alpha RGBA8. Blend math currently operates
//! directly on normalized channel values; a linear-light color pipeline is a
//! separate, explicitly planned engine layer.

use std::fmt;

mod graph;

pub use graph::{GraphRenderError, render_compositing_graph};

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
        if width == 0 || height == 0 {
            return Err(RenderError::InvalidDimensions);
        }
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
        Ok(Self {
            width,
            height,
            pixels,
        })
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

/// Basic creative color controls. Values operate on normalized display RGB
/// channels; this is an SDR working-space utility, not a color-managed grading
/// pipeline.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorAdjustments {
    /// Exposure compensation in stops, supported range -8..=8.
    pub exposure_stops: f32,
    /// Contrast pivoted around 0.5, supported range -1..=1.
    pub contrast: f32,
    /// Saturation multiplier, supported range 0..=3.
    pub saturation: f32,
    /// Display gamma, supported range 0.1..=4.
    pub gamma: f32,
    /// Additive brightness offset, supported range -1..=1.
    pub brightness: f32,
}

impl Default for ColorAdjustments {
    fn default() -> Self {
        Self {
            exposure_stops: 0.0,
            contrast: 0.0,
            saturation: 1.0,
            gamma: 1.0,
            brightness: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Apply exposure, contrast, saturation, gamma and brightness to a copy.
pub fn apply_color_adjustments(
    image: &RgbaImage,
    adjustments: ColorAdjustments,
) -> Result<RgbaImage, RenderError> {
    if !adjustments.exposure_stops.is_finite()
        || !(-8.0..=8.0).contains(&adjustments.exposure_stops)
        || !adjustments.contrast.is_finite()
        || !(-1.0..=1.0).contains(&adjustments.contrast)
        || !adjustments.saturation.is_finite()
        || !(0.0..=3.0).contains(&adjustments.saturation)
        || !adjustments.gamma.is_finite()
        || !(0.1..=4.0).contains(&adjustments.gamma)
        || !adjustments.brightness.is_finite()
        || !(-1.0..=1.0).contains(&adjustments.brightness)
    {
        return Err(RenderError::InvalidColorAdjustment);
    }

    let exposure = 2.0_f32.powf(adjustments.exposure_stops);
    let contrast = 1.0 + adjustments.contrast;
    let mut output = image.clone();
    for pixel in output.pixels.as_chunks_mut::<4>().0.iter_mut() {
        let mut rgb = [
            pixel[0] as f32 / 255.0,
            pixel[1] as f32 / 255.0,
            pixel[2] as f32 / 255.0,
        ];
        let luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        for channel in &mut rgb {
            let exposed = *channel * exposure;
            let contrasted = (exposed - 0.5) * contrast + 0.5;
            let saturated = luminance + (contrasted - luminance) * adjustments.saturation;
            let brightened = (saturated + adjustments.brightness).clamp(0.0, 1.0);
            *channel = brightened.powf(1.0 / adjustments.gamma).clamp(0.0, 1.0);
        }
        pixel[0] = (rgb[0] * 255.0).round() as u8;
        pixel[1] = (rgb[1] * 255.0).round() as u8;
        pixel[2] = (rgb[2] * 255.0).round() as u8;
    }
    Ok(output)
}

/// Return a rectangular crop without changing the source image.
pub fn crop_image(image: &RgbaImage, crop: CropRect) -> Result<RgbaImage, RenderError> {
    let right = crop
        .x
        .checked_add(crop.width)
        .ok_or(RenderError::InvalidCrop)?;
    let bottom = crop
        .y
        .checked_add(crop.height)
        .ok_or(RenderError::InvalidCrop)?;
    if crop.width == 0 || crop.height == 0 || right > image.width || bottom > image.height {
        return Err(RenderError::InvalidCrop);
    }
    let mut pixels = Vec::with_capacity(crop.width as usize * crop.height as usize * 4);
    for y in crop.y..bottom {
        let start = ((y as usize * image.width as usize) + crop.x as usize) * 4;
        let end = start + crop.width as usize * 4;
        pixels.extend_from_slice(&image.pixels[start..end]);
    }
    RgbaImage::new(crop.width, crop.height, pixels)
}

/// Remove pixels close to a chosen RGB key color using a soft alpha edge.
/// Threshold and softness are normalized RGB distances in the range 0..=1.
pub fn apply_chroma_key(
    image: &RgbaImage,
    key_rgb: [u8; 3],
    threshold: f32,
    softness: f32,
) -> Result<RgbaImage, RenderError> {
    if !threshold.is_finite()
        || !softness.is_finite()
        || !(0.0..=1.0).contains(&threshold)
        || !(0.0..=1.0).contains(&softness)
    {
        return Err(RenderError::InvalidKey);
    }
    let key = key_rgb.map(|channel| channel as f32 / 255.0);
    let mut output = image.clone();
    for pixel in output.pixels.as_chunks_mut::<4>().0.iter_mut() {
        let distance = (0..3)
            .map(|channel| {
                let delta = pixel[channel] as f32 / 255.0 - key[channel];
                delta * delta
            })
            .sum::<f32>()
            .sqrt()
            / 3.0_f32.sqrt();
        let keep = if softness <= f32::EPSILON {
            if distance <= threshold { 0.0 } else { 1.0 }
        } else {
            ((distance - threshold) / softness).clamp(0.0, 1.0)
        };
        pixel[3] = (pixel[3] as f32 * keep).round() as u8;
    }
    Ok(output)
}

pub struct CompositeLayer<'a> {
    pub image: &'a RgbaImage,
    pub opacity: f32,
    pub blend_mode: BlendMode,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform2D {
    /// Destination position of the source anchor, in output pixels.
    pub position: [f32; 2],
    /// Independent X/Y scale. Negative values flip the source axis.
    pub scale: [f32; 2],
    /// Rotation in radians, clockwise in screen coordinates.
    pub rotation_radians: f32,
    /// Source-space anchor in pixels.
    pub anchor: [f32; 2],
}

pub struct TransformedLayer<'a> {
    pub image: &'a RgbaImage,
    pub transform: Transform2D,
    pub opacity: f32,
    pub blend_mode: BlendMode,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RenderError {
    InvalidDimensions,
    InvalidBufferLength { expected: usize, actual: usize },
    LayerDimensionsMismatch,
    InvalidOpacity,
    InvalidTransform,
    InvalidColorAdjustment,
    InvalidCrop,
    InvalidKey,
}

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDimensions => write!(
                f,
                "image dimensions are invalid or overflow addressable memory"
            ),
            Self::InvalidBufferLength { expected, actual } => write!(
                f,
                "RGBA buffer length mismatch: expected {expected}, got {actual}"
            ),
            Self::LayerDimensionsMismatch => {
                write!(f, "all compositor layers must match the output dimensions")
            }
            Self::InvalidOpacity => write!(f, "layer opacity must be finite and between 0 and 1"),
            Self::InvalidTransform => write!(
                f,
                "layer transform values must be finite and scale must be non-zero"
            ),
            Self::InvalidColorAdjustment => write!(
                f,
                "color adjustment values are outside their supported finite ranges"
            ),
            Self::InvalidCrop => write!(
                f,
                "crop rectangle must be non-empty and fully inside the source image"
            ),
            Self::InvalidKey => write!(f, "chroma key color and thresholds must be valid"),
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
        for (destination, source) in output
            .pixels
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(layer.image.pixels.as_chunks::<4>().0.iter())
        {
            blend_pixel(destination, source, layer.opacity, layer.blend_mode);
        }
    }
    Ok(output)
}

/// Composite differently sized layers with position, scale, rotation and anchor transforms.
/// Sampling is nearest-neighbour; higher-quality reconstruction filters are a later render stage.
pub fn composite_transformed(
    width: u32,
    height: u32,
    layers: &[TransformedLayer<'_>],
) -> Result<RgbaImage, RenderError> {
    let mut output = RgbaImage::transparent(width, height)?;
    for layer in layers {
        let transform = layer.transform;
        if !layer.opacity.is_finite() || !(0.0..=1.0).contains(&layer.opacity) {
            return Err(RenderError::InvalidOpacity);
        }
        if transform
            .position
            .iter()
            .chain(transform.scale.iter())
            .chain(transform.anchor.iter())
            .any(|value| !value.is_finite())
            || !transform.rotation_radians.is_finite()
            || transform.scale[0].abs() <= f32::EPSILON
            || transform.scale[1].abs() <= f32::EPSILON
        {
            return Err(RenderError::InvalidTransform);
        }
        if layer.opacity == 0.0 {
            continue;
        }

        let (sin, cos) = transform.rotation_radians.sin_cos();
        for output_y in 0..height {
            for output_x in 0..width {
                let delta_x = output_x as f32 + 0.5 - transform.position[0];
                let delta_y = output_y as f32 + 0.5 - transform.position[1];
                let local_x = cos * delta_x + sin * delta_y;
                let local_y = -sin * delta_x + cos * delta_y;
                let source_x = local_x / transform.scale[0] + transform.anchor[0];
                let source_y = local_y / transform.scale[1] + transform.anchor[1];
                if source_x < 0.0
                    || source_y < 0.0
                    || source_x >= layer.image.width as f32
                    || source_y >= layer.image.height as f32
                {
                    continue;
                }
                let source_index = ((source_y.floor() as usize * layer.image.width as usize)
                    + source_x.floor() as usize)
                    * 4;
                let output_index = ((output_y as usize * width as usize) + output_x as usize) * 4;
                blend_pixel(
                    &mut output.pixels[output_index..output_index + 4],
                    &layer.image.pixels[source_index..source_index + 4],
                    layer.opacity,
                    layer.blend_mode,
                );
            }
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
        destination[channel] =
            ((premultiplied / output_alpha).clamp(0.0, 1.0) * 255.0).round() as u8;
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
        let result = composite(
            1,
            1,
            &[
                CompositeLayer {
                    image: &background,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                },
                CompositeLayer {
                    image: &foreground,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                },
            ],
        )
        .unwrap();
        assert_eq!(result.pixel(0, 0), Some([255, 0, 0, 255]));
    }

    #[test]
    fn half_opacity_source_over_opaque_background_blends_channels() {
        let background = RgbaImage::solid(1, 1, [0, 0, 255, 255]).unwrap();
        let foreground = RgbaImage::solid(1, 1, [255, 0, 0, 255]).unwrap();
        let result = composite(
            1,
            1,
            &[
                CompositeLayer {
                    image: &background,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                },
                CompositeLayer {
                    image: &foreground,
                    opacity: 0.5,
                    blend_mode: BlendMode::Normal,
                },
            ],
        )
        .unwrap();
        assert_eq!(result.pixel(0, 0), Some([128, 0, 128, 255]));
    }

    #[test]
    fn transparent_pixel_does_not_change_output() {
        let background = RgbaImage::solid(1, 1, [10, 20, 30, 255]).unwrap();
        let transparent = RgbaImage::solid(1, 1, [255, 255, 255, 0]).unwrap();
        let result = composite(
            1,
            1,
            &[
                CompositeLayer {
                    image: &background,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                },
                CompositeLayer {
                    image: &transparent,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                },
            ],
        )
        .unwrap();
        assert_eq!(result.pixel(0, 0), Some([10, 20, 30, 255]));
    }

    #[test]
    fn multiply_blend_mode_combines_source_and_destination() {
        let background = RgbaImage::solid(1, 1, [128, 128, 128, 255]).unwrap();
        let foreground = RgbaImage::solid(1, 1, [128, 64, 255, 255]).unwrap();
        let result = composite(
            1,
            1,
            &[
                CompositeLayer {
                    image: &background,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                },
                CompositeLayer {
                    image: &foreground,
                    opacity: 1.0,
                    blend_mode: BlendMode::Multiply,
                },
            ],
        )
        .unwrap();
        assert_eq!(result.pixel(0, 0), Some([64, 32, 128, 255]));
    }

    #[test]
    fn screen_blend_mode_lightens_destination() {
        let background = RgbaImage::solid(1, 1, [64, 64, 64, 255]).unwrap();
        let foreground = RgbaImage::solid(1, 1, [128, 128, 128, 255]).unwrap();
        let result = composite(
            1,
            1,
            &[
                CompositeLayer {
                    image: &background,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                },
                CompositeLayer {
                    image: &foreground,
                    opacity: 1.0,
                    blend_mode: BlendMode::Screen,
                },
            ],
        )
        .unwrap();
        assert_eq!(result.pixel(0, 0), Some([160, 160, 160, 255]));
    }

    #[test]
    fn additive_blend_mode_saturates_channels() {
        let background = RgbaImage::solid(1, 1, [200, 100, 10, 255]).unwrap();
        let foreground = RgbaImage::solid(1, 1, [100, 180, 20, 255]).unwrap();
        let result = composite(
            1,
            1,
            &[
                CompositeLayer {
                    image: &background,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                },
                CompositeLayer {
                    image: &foreground,
                    opacity: 1.0,
                    blend_mode: BlendMode::Add,
                },
            ],
        )
        .unwrap();
        assert_eq!(result.pixel(0, 0), Some([255, 255, 30, 255]));
    }

    #[test]
    fn transformed_compositor_positions_a_source_layer() {
        let source = RgbaImage::solid(2, 1, [255, 0, 0, 255]).unwrap();
        let result = composite_transformed(
            4,
            1,
            &[TransformedLayer {
                image: &source,
                transform: Transform2D {
                    position: [1.0, 0.5],
                    scale: [1.0, 1.0],
                    rotation_radians: 0.0,
                    anchor: [0.0, 0.0],
                },
                opacity: 1.0,
                blend_mode: BlendMode::Normal,
            }],
        )
        .unwrap();
        assert_eq!(result.pixel(0, 0), Some([0, 0, 0, 0]));
        assert_eq!(result.pixel(1, 0), Some([255, 0, 0, 255]));
        assert_eq!(result.pixel(2, 0), Some([255, 0, 0, 255]));
        assert_eq!(result.pixel(3, 0), Some([0, 0, 0, 0]));
    }

    #[test]
    fn transformed_compositor_rejects_zero_scale() {
        let source = RgbaImage::solid(1, 1, [255, 255, 255, 255]).unwrap();
        let result = composite_transformed(
            1,
            1,
            &[TransformedLayer {
                image: &source,
                transform: Transform2D {
                    position: [0.5, 0.5],
                    scale: [0.0, 1.0],
                    rotation_radians: 0.0,
                    anchor: [0.5, 0.5],
                },
                opacity: 1.0,
                blend_mode: BlendMode::Normal,
            }],
        );
        assert_eq!(result, Err(RenderError::InvalidTransform));
    }

    #[test]
    fn rejects_mismatched_layer_dimensions() {
        let layer = RgbaImage::solid(2, 2, [0, 0, 0, 255]).unwrap();
        assert_eq!(
            composite(
                1,
                1,
                &[CompositeLayer {
                    image: &layer,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal
                }]
            ),
            Err(RenderError::LayerDimensionsMismatch)
        );
    }

    #[test]
    fn color_adjustments_preserve_alpha_and_validate_ranges() {
        let source = RgbaImage::solid(1, 1, [100, 120, 140, 77]).unwrap();
        let result = apply_color_adjustments(
            &source,
            ColorAdjustments {
                exposure_stops: 1.0,
                ..ColorAdjustments::default()
            },
        )
        .unwrap();
        assert_eq!(result.pixel(0, 0), Some([200, 240, 255, 77]));
        assert_eq!(
            apply_color_adjustments(
                &source,
                ColorAdjustments {
                    gamma: 0.0,
                    ..ColorAdjustments::default()
                }
            ),
            Err(RenderError::InvalidColorAdjustment)
        );
    }

    #[test]
    fn crop_image_returns_requested_rectangle() {
        let source = RgbaImage::new(
            2,
            2,
            vec![1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255],
        )
        .unwrap();
        let cropped = crop_image(
            &source,
            CropRect {
                x: 1,
                y: 0,
                width: 1,
                height: 2,
            },
        )
        .unwrap();
        assert_eq!(cropped.width, 1);
        assert_eq!(cropped.height, 2);
        assert_eq!(cropped.pixels(), &[2, 0, 0, 255, 4, 0, 0, 255]);
        assert_eq!(
            crop_image(
                &source,
                CropRect {
                    x: 1,
                    y: 1,
                    width: 2,
                    height: 1
                }
            ),
            Err(RenderError::InvalidCrop)
        );
    }

    #[test]
    fn chroma_key_removes_key_color_and_keeps_distant_color() {
        let source = RgbaImage::new(2, 1, vec![0, 255, 0, 255, 255, 0, 0, 255]).unwrap();
        let keyed = apply_chroma_key(&source, [0, 255, 0], 0.05, 0.1).unwrap();
        assert_eq!(keyed.pixel(0, 0), Some([0, 255, 0, 0]));
        assert_eq!(keyed.pixel(1, 0), Some([255, 0, 0, 255]));
    }

    #[test]
    fn rejects_invalid_opacity() {
        let layer = RgbaImage::solid(1, 1, [0, 0, 0, 255]).unwrap();
        assert_eq!(
            composite(
                1,
                1,
                &[CompositeLayer {
                    image: &layer,
                    opacity: f32::NAN,
                    blend_mode: BlendMode::Normal
                }]
            ),
            Err(RenderError::InvalidOpacity)
        );
    }
}
