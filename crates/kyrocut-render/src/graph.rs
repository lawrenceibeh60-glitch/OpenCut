//! CPU execution backend for KYROCUT X1 compositing graphs.
//!
//! This evaluator is intentionally deterministic and backend-neutral at its
//! input boundary. The same graph document can later be evaluated by a GPU
//! backend; this CPU path is the correctness reference and low-resource fallback.

use std::collections::HashMap;
use std::fmt;

use kyrocut_core::{CompositingGraph, Frame, GraphError, GraphNode, NodeOperation, ScalarCurve};
use serde_json::Value;

use crate::{
    BlendMode, ColorAdjustments, CompositeLayer, RenderError, RgbaImage, Transform2D,
    TransformedLayer, apply_chroma_key, apply_color_adjustments, composite, composite_transformed,
};

#[derive(Debug, Clone, PartialEq)]
pub enum GraphRenderError {
    InvalidGraph(GraphError),
    MissingSource(String),
    MissingParameter {
        node_id: String,
        parameter: String,
    },
    InvalidParameter {
        node_id: String,
        parameter: String,
    },
    MissingInput {
        node_id: String,
        socket_id: String,
    },
    MissingOutput,
    ValueTypeMismatch {
        node_id: String,
        socket_id: String,
    },
    ImageDimensionsMismatch,
    InvalidAnimation {
        node_id: String,
        property: String,
        message: String,
    },
    Render(RenderError),
}

impl fmt::Display for GraphRenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidGraph(error) => write!(f, "invalid compositing graph: {error}"),
            Self::MissingSource(id) => write!(f, "no image source was provided for media ID {id}"),
            Self::MissingParameter { node_id, parameter } => {
                write!(
                    f,
                    "node {node_id} is missing required parameter {parameter}"
                )
            }
            Self::InvalidParameter { node_id, parameter } => {
                write!(f, "node {node_id} has an invalid parameter {parameter}")
            }
            Self::MissingInput { node_id, socket_id } => {
                write!(f, "node {node_id} has no connected input {socket_id}")
            }
            Self::MissingOutput => write!(f, "compositing graph did not produce an Output image"),
            Self::ValueTypeMismatch { node_id, socket_id } => {
                write!(
                    f,
                    "node {node_id} received the wrong value type on socket {socket_id}"
                )
            }
            Self::ImageDimensionsMismatch => {
                write!(
                    f,
                    "blend inputs and optional mask must have matching dimensions"
                )
            }
            Self::InvalidAnimation {
                node_id,
                property,
                message,
            } => write!(
                f,
                "node {node_id} has invalid animation for {property}: {message}"
            ),
            Self::Render(error) => write!(f, "render operation failed: {error}"),
        }
    }
}

impl std::error::Error for GraphRenderError {}

impl From<RenderError> for GraphRenderError {
    fn from(value: RenderError) -> Self {
        Self::Render(value)
    }
}

#[derive(Clone)]
enum GraphValue {
    Image(RgbaImage),
    Mask(RgbaImage),
}

/// Evaluate a graph after applying its serialized scalar curves at an exact project frame.
pub fn render_compositing_graph_at_frame(
    graph: &CompositingGraph,
    media_sources: &HashMap<String, RgbaImage>,
    width: u32,
    height: u32,
    frame: u64,
) -> Result<RgbaImage, GraphRenderError> {
    let mut evaluated = graph.clone();
    for node in &mut evaluated.nodes {
        let Some(animation) = node.parameters.get("animation").cloned() else {
            continue;
        };
        let curves = animation
            .as_object()
            .ok_or_else(|| GraphRenderError::InvalidAnimation {
                node_id: node.id.clone(),
                property: "animation".into(),
                message: "expected an object keyed by animated property".into(),
            })?;
        for (property, curve_value) in curves {
            let curve: ScalarCurve =
                serde_json::from_value(curve_value.clone()).map_err(|error| {
                    GraphRenderError::InvalidAnimation {
                        node_id: node.id.clone(),
                        property: property.clone(),
                        message: error.to_string(),
                    }
                })?;
            curve
                .validate()
                .map_err(|error| GraphRenderError::InvalidAnimation {
                    node_id: node.id.clone(),
                    property: property.clone(),
                    message: error.to_string(),
                })?;
            if let Some(value) = curve.evaluate(Frame(frame)) {
                node.parameters.insert(property.clone(), Value::from(value));
            }
        }
    }
    render_compositing_graph(&evaluated, media_sources, width, height)
}

/// Evaluate a validated compositing graph using CPU RGBA8 operations.
///
/// Media sources are supplied by stable media ID, so the graph document never
/// embeds machine-specific paths or decoded pixel buffers.
pub fn render_compositing_graph(
    graph: &CompositingGraph,
    media_sources: &HashMap<String, RgbaImage>,
    width: u32,
    height: u32,
) -> Result<RgbaImage, GraphRenderError> {
    graph.validate().map_err(GraphRenderError::InvalidGraph)?;

    let nodes = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<HashMap<_, _>>();
    let mut incoming = HashMap::new();
    for connection in &graph.connections {
        incoming.insert(
            (
                connection.to.node_id.as_str(),
                connection.to.socket_id.as_str(),
            ),
            (
                connection.from.node_id.as_str(),
                connection.from.socket_id.as_str(),
            ),
        );
    }

    let mut values: HashMap<(String, String), GraphValue> = HashMap::new();
    for node_id in graph
        .execution_order()
        .map_err(GraphRenderError::InvalidGraph)?
    {
        let node = nodes.get(node_id.as_str()).copied().ok_or_else(|| {
            GraphRenderError::InvalidGraph(GraphError::MissingNode(node_id.clone()))
        })?;

        match node.operation {
            NodeOperation::MediaSource => {
                let media_id = string_parameter(node, "mediaId", true)?
                    .ok_or_else(|| missing_parameter(node, "mediaId"))?;
                let image = media_sources
                    .get(media_id)
                    .ok_or_else(|| GraphRenderError::MissingSource(media_id.to_owned()))?
                    .clone();
                values.insert((node.id.clone(), "image".into()), GraphValue::Image(image));
            }
            NodeOperation::Transform2d => {
                let image = image_input(node, "image", &incoming, &values)?;
                let transform = Transform2D {
                    position: [
                        number_parameter(node, "positionX", width as f64 / 2.0)? as f32,
                        number_parameter(node, "positionY", height as f64 / 2.0)? as f32,
                    ],
                    scale: [
                        number_parameter(node, "scaleX", 1.0)? as f32,
                        number_parameter(node, "scaleY", 1.0)? as f32,
                    ],
                    rotation_radians: number_parameter(node, "rotationRadians", 0.0)? as f32,
                    anchor: [
                        number_parameter(node, "anchorX", image.width as f64 / 2.0)? as f32,
                        number_parameter(node, "anchorY", image.height as f64 / 2.0)? as f32,
                    ],
                };
                let transformed = composite_transformed(
                    width,
                    height,
                    &[TransformedLayer {
                        image: &image,
                        transform,
                        opacity: number_parameter(node, "opacity", 1.0)? as f32,
                        blend_mode: BlendMode::Normal,
                    }],
                )?;
                values.insert(
                    (node.id.clone(), "image".into()),
                    GraphValue::Image(transformed),
                );
            }
            NodeOperation::ColorGrade => {
                let image = image_input(node, "image", &incoming, &values)?;
                let adjustments = ColorAdjustments {
                    exposure_stops: number_parameter(node, "exposureStops", 0.0)? as f32,
                    contrast: number_parameter(node, "contrast", 0.0)? as f32,
                    saturation: number_parameter(node, "saturation", 1.0)? as f32,
                    gamma: number_parameter(node, "gamma", 1.0)? as f32,
                    brightness: number_parameter(node, "brightness", 0.0)? as f32,
                };
                let graded = apply_color_adjustments(&image, adjustments)?;
                values.insert((node.id.clone(), "image".into()), GraphValue::Image(graded));
            }
            NodeOperation::ChromaKey => {
                let image = image_input(node, "image", &incoming, &values)?;
                let key = color_parameter(node)?;
                let keyed = apply_chroma_key(
                    &image,
                    key,
                    number_parameter(node, "threshold", 0.12)? as f32,
                    number_parameter(node, "softness", 0.08)? as f32,
                )?;
                values.insert((node.id.clone(), "image".into()), GraphValue::Image(keyed));
            }
            NodeOperation::Mask => {
                let image = image_input(node, "image", &incoming, &values)?;
                let mut pixels = Vec::with_capacity(image.pixels().len());
                for pixel in image.pixels().as_chunks::<4>().0 {
                    let luminance = pixel[0] as f32 * 0.2126
                        + pixel[1] as f32 * 0.7152
                        + pixel[2] as f32 * 0.0722;
                    let alpha = (luminance * pixel[3] as f32 / 255.0).round() as u8;
                    pixels.extend_from_slice(&[255, 255, 255, alpha]);
                }
                let mask = RgbaImage::new(image.width, image.height, pixels)?;
                values.insert((node.id.clone(), "mask".into()), GraphValue::Mask(mask));
            }
            NodeOperation::Blend | NodeOperation::Merge => {
                let base = image_input(node, "base", &incoming, &values)?;
                let mut foreground = image_input(node, "foreground", &incoming, &values)?;
                if base.width != foreground.width || base.height != foreground.height {
                    return Err(GraphRenderError::ImageDimensionsMismatch);
                }
                if let Some(mask) = optional_mask_input(node, "mask", &incoming, &values)? {
                    if mask.width != foreground.width || mask.height != foreground.height {
                        return Err(GraphRenderError::ImageDimensionsMismatch);
                    }
                    let mut pixels = foreground.pixels().to_vec();
                    for (pixel, mask_pixel) in pixels
                        .as_chunks_mut::<4>()
                        .0
                        .iter_mut()
                        .zip(mask.pixels().as_chunks::<4>().0.iter())
                    {
                        pixel[3] = (pixel[3] as u16 * mask_pixel[3] as u16 / 255) as u8;
                    }
                    foreground = RgbaImage::new(foreground.width, foreground.height, pixels)?;
                }
                let mode = blend_mode_parameter(node)?;
                let result = composite(
                    base.width,
                    base.height,
                    &[
                        CompositeLayer {
                            image: &base,
                            opacity: 1.0,
                            blend_mode: BlendMode::Normal,
                        },
                        CompositeLayer {
                            image: &foreground,
                            opacity: number_parameter(node, "opacity", 1.0)? as f32,
                            blend_mode: mode,
                        },
                    ],
                )?;
                values.insert((node.id.clone(), "image".into()), GraphValue::Image(result));
            }
            NodeOperation::Output => {
                let image = image_input(node, "image", &incoming, &values)?;
                values.insert((node.id.clone(), "result".into()), GraphValue::Image(image));
            }
        }
    }

    let output_node = graph
        .nodes
        .iter()
        .find(|node| node.operation == NodeOperation::Output)
        .ok_or(GraphRenderError::MissingOutput)?;
    match values.get(&(output_node.id.clone(), "result".into())) {
        Some(GraphValue::Image(image)) => Ok(image.clone()),
        _ => Err(GraphRenderError::MissingOutput),
    }
}

fn missing_parameter(node: &GraphNode, parameter: &str) -> GraphRenderError {
    GraphRenderError::MissingParameter {
        node_id: node.id.clone(),
        parameter: parameter.into(),
    }
}

fn string_parameter<'a>(
    node: &'a GraphNode,
    parameter: &str,
    required: bool,
) -> Result<Option<&'a str>, GraphRenderError> {
    match node.parameters.get(parameter) {
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value)),
        Some(_) => Err(GraphRenderError::InvalidParameter {
            node_id: node.id.clone(),
            parameter: parameter.into(),
        }),
        None if required => Err(missing_parameter(node, parameter)),
        None => Ok(None),
    }
}

fn number_parameter(
    node: &GraphNode,
    parameter: &str,
    default: f64,
) -> Result<f64, GraphRenderError> {
    let Some(value) = node.parameters.get(parameter) else {
        return Ok(default);
    };
    let number = value
        .as_f64()
        .ok_or_else(|| GraphRenderError::InvalidParameter {
            node_id: node.id.clone(),
            parameter: parameter.into(),
        })?;
    if !number.is_finite() {
        return Err(GraphRenderError::InvalidParameter {
            node_id: node.id.clone(),
            parameter: parameter.into(),
        });
    }
    Ok(number)
}

fn color_parameter(node: &GraphNode) -> Result<[u8; 3], GraphRenderError> {
    let value = node
        .parameters
        .get("keyRgb")
        .ok_or_else(|| missing_parameter(node, "keyRgb"))?;
    let values = value
        .as_array()
        .ok_or_else(|| GraphRenderError::InvalidParameter {
            node_id: node.id.clone(),
            parameter: "keyRgb".into(),
        })?;
    if values.len() != 3 {
        return Err(GraphRenderError::InvalidParameter {
            node_id: node.id.clone(),
            parameter: "keyRgb".into(),
        });
    }
    let mut color = [0; 3];
    for (index, value) in values.iter().enumerate() {
        let channel = value
            .as_u64()
            .filter(|channel| *channel <= 255)
            .ok_or_else(|| GraphRenderError::InvalidParameter {
                node_id: node.id.clone(),
                parameter: "keyRgb".into(),
            })?;
        color[index] = channel as u8;
    }
    Ok(color)
}

fn blend_mode_parameter(node: &GraphNode) -> Result<BlendMode, GraphRenderError> {
    match string_parameter(node, "blendMode", false)? {
        None | Some("normal") => Ok(BlendMode::Normal),
        Some("multiply") => Ok(BlendMode::Multiply),
        Some("screen") => Ok(BlendMode::Screen),
        Some("add") => Ok(BlendMode::Add),
        Some(_) => Err(GraphRenderError::InvalidParameter {
            node_id: node.id.clone(),
            parameter: "blendMode".into(),
        }),
    }
}

fn image_input(
    node: &GraphNode,
    socket_id: &str,
    incoming: &HashMap<(&str, &str), (&str, &str)>,
    values: &HashMap<(String, String), GraphValue>,
) -> Result<RgbaImage, GraphRenderError> {
    let (source_node, source_socket) = incoming
        .get(&(node.id.as_str(), socket_id))
        .copied()
        .ok_or_else(|| GraphRenderError::MissingInput {
            node_id: node.id.clone(),
            socket_id: socket_id.into(),
        })?;
    match values.get(&(source_node.to_owned(), source_socket.to_owned())) {
        Some(GraphValue::Image(image)) => Ok(image.clone()),
        _ => Err(GraphRenderError::ValueTypeMismatch {
            node_id: node.id.clone(),
            socket_id: socket_id.into(),
        }),
    }
}

fn optional_mask_input(
    node: &GraphNode,
    socket_id: &str,
    incoming: &HashMap<(&str, &str), (&str, &str)>,
    values: &HashMap<(String, String), GraphValue>,
) -> Result<Option<RgbaImage>, GraphRenderError> {
    let Some((source_node, source_socket)) = incoming.get(&(node.id.as_str(), socket_id)).copied()
    else {
        return Ok(None);
    };
    match values.get(&(source_node.to_owned(), source_socket.to_owned())) {
        Some(GraphValue::Mask(mask)) => Ok(Some(mask.clone())),
        _ => Err(GraphRenderError::ValueTypeMismatch {
            node_id: node.id.clone(),
            socket_id: socket_id.into(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kyrocut_core::{GraphConnection, GraphEndpoint, GraphNode, GraphSocket, SocketType};
    use std::collections::BTreeMap;

    fn socket(id: &str, socket_type: SocketType) -> GraphSocket {
        GraphSocket {
            id: id.into(),
            name: id.into(),
            socket_type,
        }
    }

    fn node(
        id: &str,
        operation: NodeOperation,
        inputs: Vec<GraphSocket>,
        outputs: Vec<GraphSocket>,
    ) -> GraphNode {
        GraphNode {
            id: id.into(),
            label: id.into(),
            operation,
            parameters: BTreeMap::new(),
            inputs,
            outputs,
        }
    }

    fn connect(id: &str, from: &str, output: &str, to: &str, input: &str) -> GraphConnection {
        GraphConnection {
            id: id.into(),
            from: GraphEndpoint {
                node_id: from.into(),
                socket_id: output.into(),
            },
            to: GraphEndpoint {
                node_id: to.into(),
                socket_id: input.into(),
            },
        }
    }

    #[test]
    fn executes_source_grade_output_pipeline() {
        let mut source = node(
            "source",
            NodeOperation::MediaSource,
            vec![],
            vec![socket("image", SocketType::Image)],
        );
        source
            .parameters
            .insert("mediaId".into(), Value::String("shot-1".into()));
        let mut grade = node(
            "grade",
            NodeOperation::ColorGrade,
            vec![socket("image", SocketType::Image)],
            vec![socket("image", SocketType::Image)],
        );
        grade
            .parameters
            .insert("exposureStops".into(), Value::from(1.0));
        let output = node(
            "output",
            NodeOperation::Output,
            vec![socket("image", SocketType::Image)],
            vec![],
        );
        let graph = CompositingGraph {
            id: "test-graph".into(),
            nodes: vec![source, grade, output],
            connections: vec![
                connect("c1", "source", "image", "grade", "image"),
                connect("c2", "grade", "image", "output", "image"),
            ],
        };
        let media = HashMap::from([(
            "shot-1".into(),
            RgbaImage::solid(1, 1, [40, 50, 60, 200]).unwrap(),
        )]);
        let rendered = render_compositing_graph(&graph, &media, 1, 1).unwrap();
        assert_eq!(rendered.pixel(0, 0), Some([80, 100, 120, 200]));
    }

    #[test]
    fn evaluates_scalar_curves_at_the_requested_project_frame() {
        let mut source = node(
            "source",
            NodeOperation::MediaSource,
            vec![],
            vec![socket("image", SocketType::Image)],
        );
        source
            .parameters
            .insert("mediaId".into(), Value::String("shot".into()));
        let mut grade = node(
            "grade",
            NodeOperation::ColorGrade,
            vec![socket("image", SocketType::Image)],
            vec![socket("image", SocketType::Image)],
        );
        grade.parameters.insert(
            "animation".into(),
            serde_json::json!({
                "exposureStops": {
                    "keyframes": [
                        { "frame": 0, "value": 0.0, "interpolation": "linear" },
                        { "frame": 10, "value": 1.0, "interpolation": "linear" }
                    ]
                }
            }),
        );
        let output = node(
            "output",
            NodeOperation::Output,
            vec![socket("image", SocketType::Image)],
            vec![],
        );
        let graph = CompositingGraph {
            id: "animated-grade".into(),
            nodes: vec![source, grade, output],
            connections: vec![
                connect("c1", "source", "image", "grade", "image"),
                connect("c2", "grade", "image", "output", "image"),
            ],
        };
        let media = HashMap::from([(
            "shot".into(),
            RgbaImage::solid(1, 1, [40, 50, 60, 255]).unwrap(),
        )]);
        let before = render_compositing_graph_at_frame(&graph, &media, 1, 1, 0).unwrap();
        let after = render_compositing_graph_at_frame(&graph, &media, 1, 1, 10).unwrap();
        assert_eq!(before.pixel(0, 0), Some([40, 50, 60, 255]));
        assert_eq!(after.pixel(0, 0), Some([80, 100, 120, 255]));
    }

    #[test]
    fn reports_missing_source_media() {
        let mut source = node(
            "source",
            NodeOperation::MediaSource,
            vec![],
            vec![socket("image", SocketType::Image)],
        );
        source
            .parameters
            .insert("mediaId".into(), Value::String("missing".into()));
        let output = node(
            "output",
            NodeOperation::Output,
            vec![socket("image", SocketType::Image)],
            vec![],
        );
        let graph = CompositingGraph {
            id: "missing-source".into(),
            nodes: vec![source, output],
            connections: vec![connect("c1", "source", "image", "output", "image")],
        };
        assert_eq!(
            render_compositing_graph(&graph, &HashMap::new(), 1, 1),
            Err(GraphRenderError::MissingSource("missing".into()))
        );
    }

    #[test]
    fn executes_chroma_key_operation() {
        let mut source = node(
            "source",
            NodeOperation::MediaSource,
            vec![],
            vec![socket("image", SocketType::Image)],
        );
        source
            .parameters
            .insert("mediaId".into(), Value::String("greenscreen".into()));
        let mut key = node(
            "key",
            NodeOperation::ChromaKey,
            vec![socket("image", SocketType::Image)],
            vec![socket("image", SocketType::Image)],
        );
        key.parameters
            .insert("keyRgb".into(), serde_json::json!([0, 255, 0]));
        key.parameters.insert("threshold".into(), Value::from(0.05));
        key.parameters.insert("softness".into(), Value::from(0.1));
        let output = node(
            "output",
            NodeOperation::Output,
            vec![socket("image", SocketType::Image)],
            vec![],
        );
        let graph = CompositingGraph {
            id: "key-graph".into(),
            nodes: vec![source, key, output],
            connections: vec![
                connect("c1", "source", "image", "key", "image"),
                connect("c2", "key", "image", "output", "image"),
            ],
        };
        let media = HashMap::from([(
            "greenscreen".into(),
            RgbaImage::new(2, 1, vec![0, 255, 0, 255, 255, 0, 0, 255]).unwrap(),
        )]);
        let rendered = render_compositing_graph(&graph, &media, 2, 1).unwrap();
        assert_eq!(rendered.pixel(0, 0), Some([0, 255, 0, 0]));
        assert_eq!(rendered.pixel(1, 0), Some([255, 0, 0, 255]));
    }
    #[test]
    fn executes_alpha_blend_node() {
        let mut base = node(
            "base",
            NodeOperation::MediaSource,
            vec![],
            vec![socket("image", SocketType::Image)],
        );
        base.parameters
            .insert("mediaId".into(), Value::String("base".into()));
        let mut top = node(
            "top",
            NodeOperation::MediaSource,
            vec![],
            vec![socket("image", SocketType::Image)],
        );
        top.parameters
            .insert("mediaId".into(), Value::String("top".into()));
        let mut blend = node(
            "blend",
            NodeOperation::Blend,
            vec![
                socket("base", SocketType::Image),
                socket("foreground", SocketType::Image),
            ],
            vec![socket("image", SocketType::Image)],
        );
        blend.parameters.insert("opacity".into(), Value::from(0.5));
        let output = node(
            "output",
            NodeOperation::Output,
            vec![socket("image", SocketType::Image)],
            vec![],
        );
        let graph = CompositingGraph {
            id: "blend-graph".into(),
            nodes: vec![base, top, blend, output],
            connections: vec![
                connect("c1", "base", "image", "blend", "base"),
                connect("c2", "top", "image", "blend", "foreground"),
                connect("c3", "blend", "image", "output", "image"),
            ],
        };
        let media = HashMap::from([
            (
                "base".into(),
                RgbaImage::solid(1, 1, [0, 0, 255, 255]).unwrap(),
            ),
            (
                "top".into(),
                RgbaImage::solid(1, 1, [255, 0, 0, 255]).unwrap(),
            ),
        ]);
        let rendered = render_compositing_graph(&graph, &media, 1, 1).unwrap();
        assert_eq!(rendered.pixel(0, 0), Some([128, 0, 128, 255]));
    }

    #[test]
    fn mask_node_controls_blend_opacity() {
        let mut base = node(
            "base",
            NodeOperation::MediaSource,
            vec![],
            vec![socket("image", SocketType::Image)],
        );
        base.parameters
            .insert("mediaId".into(), Value::String("base".into()));
        let mut top = node(
            "top",
            NodeOperation::MediaSource,
            vec![],
            vec![socket("image", SocketType::Image)],
        );
        top.parameters
            .insert("mediaId".into(), Value::String("top".into()));
        let mut matte_source = node(
            "matte-source",
            NodeOperation::MediaSource,
            vec![],
            vec![socket("image", SocketType::Image)],
        );
        matte_source
            .parameters
            .insert("mediaId".into(), Value::String("matte".into()));
        let matte = node(
            "matte",
            NodeOperation::Mask,
            vec![socket("image", SocketType::Image)],
            vec![socket("mask", SocketType::Mask)],
        );
        let blend = node(
            "blend",
            NodeOperation::Blend,
            vec![
                socket("base", SocketType::Image),
                socket("foreground", SocketType::Image),
                socket("mask", SocketType::Mask),
            ],
            vec![socket("image", SocketType::Image)],
        );
        let output = node(
            "output",
            NodeOperation::Output,
            vec![socket("image", SocketType::Image)],
            vec![],
        );
        let graph = CompositingGraph {
            id: "masked-blend".into(),
            nodes: vec![base, top, matte_source, matte, blend, output],
            connections: vec![
                connect("c1", "base", "image", "blend", "base"),
                connect("c2", "top", "image", "blend", "foreground"),
                connect("c3", "matte-source", "image", "matte", "image"),
                connect("c4", "matte", "mask", "blend", "mask"),
                connect("c5", "blend", "image", "output", "image"),
            ],
        };
        let media = HashMap::from([
            (
                "base".into(),
                RgbaImage::solid(1, 1, [0, 0, 255, 255]).unwrap(),
            ),
            (
                "top".into(),
                RgbaImage::solid(1, 1, [255, 0, 0, 255]).unwrap(),
            ),
            (
                "matte".into(),
                RgbaImage::solid(1, 1, [0, 0, 0, 255]).unwrap(),
            ),
        ]);
        let rendered = render_compositing_graph(&graph, &media, 1, 1).unwrap();
        assert_eq!(rendered.pixel(0, 0), Some([0, 0, 255, 255]));
    }
}
