#![recursion_limit = "512"]
//! Designotron engine: the document model and everything that operates on it.
//! Pure Rust with no platform dependencies; compiled to WASM for the editor
//! and linked natively by the bridge server.

pub mod ai;
pub mod codegen;
pub mod color;
pub mod components;
pub mod doc;
pub mod engine;
pub mod geom;
pub mod grids;
pub mod interact;
pub mod layout;
pub mod lint;
pub mod model;
pub mod ops;
pub mod patch;
pub mod paths;
pub mod render;
pub mod shapes;
pub mod text;
pub mod variables;

pub use engine::{Command, Engine, Query};
pub use model::Document;
