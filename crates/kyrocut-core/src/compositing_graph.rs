//! Serializable, deterministic node-graph model for compositing and effects.
//!
//! This crate-level model deliberately separates graph authoring/validation from
//! pixel execution. Desktop and web clients can share the same graph document;
//! render backends consume its validated topological execution order.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SocketType {
    Image,
    Mask,
    Scalar,
    Vector2,
    Color,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeOperation {
    MediaSource,
    Transform2d,
    ColorGrade,
    ChromaKey,
    Mask,
    Blend,
    Merge,
    Output,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSocket {
    pub id: String,
    pub name: String,
    pub socket_type: SocketType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub operation: NodeOperation,
    #[serde(default)]
    pub inputs: Vec<GraphSocket>,
    #[serde(default)]
    pub outputs: Vec<GraphSocket>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEndpoint {
    pub node_id: String,
    pub socket_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphConnection {
    pub id: String,
    pub from: GraphEndpoint,
    pub to: GraphEndpoint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositingGraph {
    pub id: String,
    pub nodes: Vec<GraphNode>,
    #[serde(default)]
    pub connections: Vec<GraphConnection>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GraphError {
    EmptyIdentifier,
    DuplicateNode(String),
    DuplicateSocket { node_id: String, socket_id: String },
    MissingNode(String),
    MissingOutputSocket { node_id: String, socket_id: String },
    MissingInputSocket { node_id: String, socket_id: String },
    SocketTypeMismatch { from: SocketType, to: SocketType },
    InputAlreadyConnected { node_id: String, socket_id: String },
    DuplicateConnection(String),
    CycleDetected,
    MissingOutputNode,
}

impl fmt::Display for GraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyIdentifier => write!(f, "graph, node, socket and connection identifiers must not be empty"),
            Self::DuplicateNode(id) => write!(f, "duplicate graph node: {id}"),
            Self::DuplicateSocket { node_id, socket_id } => write!(f, "duplicate socket {socket_id} on node {node_id}"),
            Self::MissingNode(id) => write!(f, "connection references missing node: {id}"),
            Self::MissingOutputSocket { node_id, socket_id } => write!(f, "missing output socket {socket_id} on node {node_id}"),
            Self::MissingInputSocket { node_id, socket_id } => write!(f, "missing input socket {socket_id} on node {node_id}"),
            Self::SocketTypeMismatch { from, to } => write!(f, "cannot connect {from:?} output to {to:?} input"),
            Self::InputAlreadyConnected { node_id, socket_id } => write!(f, "input {socket_id} on node {node_id} already has a connection"),
            Self::DuplicateConnection(id) => write!(f, "duplicate graph connection: {id}"),
            Self::CycleDetected => write!(f, "compositing graph contains a dependency cycle"),
            Self::MissingOutputNode => write!(f, "compositing graph requires at least one Output node"),
        }
    }
}

impl std::error::Error for GraphError {}

impl CompositingGraph {
    /// Validate identifiers, socket contracts, single-input wiring and acyclic flow.
    pub fn validate(&self) -> Result<(), GraphError> {
        if self.id.trim().is_empty() {
            return Err(GraphError::EmptyIdentifier);
        }

        let mut nodes = HashMap::with_capacity(self.nodes.len());
        let mut has_output = false;
        for node in &self.nodes {
            if node.id.trim().is_empty() || node.label.trim().is_empty() {
                return Err(GraphError::EmptyIdentifier);
            }
            if nodes.insert(node.id.as_str(), node).is_some() {
                return Err(GraphError::DuplicateNode(node.id.clone()));
            }
            has_output |= node.operation == NodeOperation::Output;

            let mut socket_ids = HashSet::new();
            for socket in node.inputs.iter().chain(node.outputs.iter()) {
                if socket.id.trim().is_empty() || socket.name.trim().is_empty() {
                    return Err(GraphError::EmptyIdentifier);
                }
                if !socket_ids.insert(socket.id.as_str()) {
                    return Err(GraphError::DuplicateSocket {
                        node_id: node.id.clone(),
                        socket_id: socket.id.clone(),
                    });
                }
            }
        }
        if !has_output {
            return Err(GraphError::MissingOutputNode);
        }

        let mut connection_ids = HashSet::new();
        let mut connected_inputs = HashSet::new();
        for connection in &self.connections {
            if connection.id.trim().is_empty() {
                return Err(GraphError::EmptyIdentifier);
            }
            if !connection_ids.insert(connection.id.as_str()) {
                return Err(GraphError::DuplicateConnection(connection.id.clone()));
            }
            let from_node = nodes.get(connection.from.node_id.as_str())
                .ok_or_else(|| GraphError::MissingNode(connection.from.node_id.clone()))?;
            let to_node = nodes.get(connection.to.node_id.as_str())
                .ok_or_else(|| GraphError::MissingNode(connection.to.node_id.clone()))?;
            let from_socket = from_node.outputs.iter()
                .find(|socket| socket.id == connection.from.socket_id)
                .ok_or_else(|| GraphError::MissingOutputSocket {
                    node_id: from_node.id.clone(),
                    socket_id: connection.from.socket_id.clone(),
                })?;
            let to_socket = to_node.inputs.iter()
                .find(|socket| socket.id == connection.to.socket_id)
                .ok_or_else(|| GraphError::MissingInputSocket {
                    node_id: to_node.id.clone(),
                    socket_id: connection.to.socket_id.clone(),
                })?;
            if from_socket.socket_type != to_socket.socket_type {
                return Err(GraphError::SocketTypeMismatch {
                    from: from_socket.socket_type,
                    to: to_socket.socket_type,
                });
            }
            if !connected_inputs.insert((to_node.id.as_str(), to_socket.id.as_str())) {
                return Err(GraphError::InputAlreadyConnected {
                    node_id: to_node.id.clone(),
                    socket_id: to_socket.id.clone(),
                });
            }
        }

        self.execution_order_unchecked()
            .map(|_| ())
    }

    /// Return node IDs in deterministic dependency order. Independent nodes
    /// retain document order, making saved graphs stable across platforms.
    pub fn execution_order(&self) -> Result<Vec<String>, GraphError> {
        self.validate()?;
        self.execution_order_unchecked()
    }

    fn execution_order_unchecked(&self) -> Result<Vec<String>, GraphError> {
        let mut indegree: HashMap<&str, usize> = self.nodes.iter()
            .map(|node| (node.id.as_str(), 0))
            .collect();
        let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
        for connection in &self.connections {
            *indegree.entry(connection.to.node_id.as_str()).or_default() += 1;
            outgoing.entry(connection.from.node_id.as_str()).or_default()
                .push(connection.to.node_id.as_str());
        }

        let mut ready = VecDeque::new();
        for node in &self.nodes {
            if indegree.get(node.id.as_str()).copied().unwrap_or(0) == 0 {
                ready.push_back(node.id.as_str());
            }
        }

        let mut order = Vec::with_capacity(self.nodes.len());
        while let Some(node_id) = ready.pop_front() {
            order.push(node_id.to_owned());
            if let Some(dependents) = outgoing.get(node_id) {
                for dependent in dependents {
                    let degree = indegree.get_mut(dependent)
                        .expect("all connection endpoints were validated");
                    *degree -= 1;
                    if *degree == 0 {
                        ready.push_back(dependent);
                    }
                }
            }
        }

        if order.len() != self.nodes.len() {
            return Err(GraphError::CycleDetected);
        }
        Ok(order)
    }

    /// Serialize a validated graph as portable JSON.
    pub fn to_json(&self) -> Result<String, GraphDocumentError> {
        self.validate().map_err(GraphDocumentError::InvalidGraph)?;
        serde_json::to_string_pretty(self).map_err(GraphDocumentError::Json)
    }

    /// Parse and validate a graph document before it can reach a renderer.
    pub fn from_json(source: &str) -> Result<Self, GraphDocumentError> {
        let graph: Self = serde_json::from_str(source).map_err(GraphDocumentError::Json)?;
        graph.validate().map_err(GraphDocumentError::InvalidGraph)?;
        Ok(graph)
    }
}

#[derive(Debug)]
pub enum GraphDocumentError {
    InvalidGraph(GraphError),
    Json(serde_json::Error),
}

impl fmt::Display for GraphDocumentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidGraph(error) => write!(f, "invalid compositing graph: {error}"),
            Self::Json(error) => write!(f, "invalid compositing graph JSON: {error}"),
        }
    }
}

impl std::error::Error for GraphDocumentError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn socket(id: &str, socket_type: SocketType) -> GraphSocket {
        GraphSocket { id: id.into(), name: id.into(), socket_type }
    }

    fn node(id: &str, operation: NodeOperation, inputs: Vec<GraphSocket>, outputs: Vec<GraphSocket>) -> GraphNode {
        GraphNode { id: id.into(), label: id.into(), operation, inputs, outputs }
    }

    fn connection(id: &str, from: &str, output: &str, to: &str, input: &str) -> GraphConnection {
        GraphConnection {
            id: id.into(),
            from: GraphEndpoint { node_id: from.into(), socket_id: output.into() },
            to: GraphEndpoint { node_id: to.into(), socket_id: input.into() },
        }
    }

    fn sample_graph() -> CompositingGraph {
        CompositingGraph {
            id: "comp-main".into(),
            nodes: vec![
                node("source", NodeOperation::MediaSource, vec![], vec![socket("image", SocketType::Image)]),
                node("grade", NodeOperation::ColorGrade, vec![socket("input", SocketType::Image)], vec![socket("image", SocketType::Image)]),
                node("output", NodeOperation::Output, vec![socket("input", SocketType::Image)], vec![]),
            ],
            connections: vec![
                connection("c1", "source", "image", "grade", "input"),
                connection("c2", "grade", "image", "output", "input"),
            ],
        }
    }

    #[test]
    fn validates_and_orders_source_grade_output_pipeline() {
        let graph = sample_graph();
        assert!(graph.validate().is_ok());
        assert_eq!(graph.execution_order().unwrap(), vec!["source", "grade", "output"]);
    }

    #[test]
    fn rejects_socket_type_mismatch() {
        let mut graph = sample_graph();
        graph.nodes[1].inputs[0].socket_type = SocketType::Mask;
        assert_eq!(
            graph.validate(),
            Err(GraphError::SocketTypeMismatch { from: SocketType::Image, to: SocketType::Mask })
        );
    }

    #[test]
    fn rejects_multiple_connections_to_one_input() {
        let mut graph = sample_graph();
        graph.nodes.insert(1, node("source-2", NodeOperation::MediaSource, vec![], vec![socket("image", SocketType::Image)]));
        graph.connections.push(connection("c3", "source-2", "image", "grade", "input"));
        assert_eq!(
            graph.validate(),
            Err(GraphError::InputAlreadyConnected { node_id: "grade".into(), socket_id: "input".into() })
        );
    }

    #[test]
    fn rejects_cycles_before_execution() {
        let mut graph = sample_graph();
        graph.connections.push(connection("cycle", "grade", "image", "source", "impossible"));
        assert!(matches!(graph.validate(), Err(GraphError::MissingInputSocket { .. })));
        graph.nodes[0].inputs.push(socket("feedback", SocketType::Image));
        graph.connections.last_mut().unwrap().to.node_id = "source".into();
        graph.connections.last_mut().unwrap().to.socket_id = "feedback".into();
        assert_eq!(graph.validate(), Err(GraphError::CycleDetected));
    }

    #[test]
    fn rejects_missing_output_node() {
        let mut graph = sample_graph();
        graph.nodes.pop();
        graph.connections.pop();
        assert_eq!(graph.validate(), Err(GraphError::MissingOutputNode));
    }

    #[test]
    fn graph_document_round_trips_and_validates() {
        let graph = sample_graph();
        let json = graph.to_json().unwrap();
        assert_eq!(CompositingGraph::from_json(&json).unwrap(), graph);
        assert!(CompositingGraph::from_json("{").is_err());
    }

    #[test]
    fn rejects_duplicate_node_and_connection_ids() {
        let mut graph = sample_graph();
        graph.nodes.push(graph.nodes[0].clone());
        assert_eq!(graph.validate(), Err(GraphError::DuplicateNode("source".into())));
        let mut graph = sample_graph();
        graph.connections.push(graph.connections[0].clone());
        assert_eq!(graph.validate(), Err(GraphError::DuplicateConnection("c1".into())));
    }
}
