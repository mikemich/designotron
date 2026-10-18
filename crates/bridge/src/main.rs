//! Designotron bridge: a local server that
//! - serves the built editor (`web/dist`) when present,
//! - relays tool calls between Claude Code (MCP over HTTP) and the open editor,
//! - runs the user's own `claude` CLI for in-app chat (Pro/Max or API key login),
//! - falls back to a native engine on `workspace/design.dtron.json` when no editor is open.

mod claude;
mod editor;
mod headless;
mod mcp;
mod security;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

use crate::claude::ClaudeInfo;
use crate::editor::EditorLink;
use crate::headless::Headless;

const DEFAULT_PORT: u16 = 5174;

pub struct AppState {
  pub port: u16,
  pub workspace: PathBuf,
  pub claude: ClaudeInfo,
  pub editor: EditorLink,
  pub headless: Headless,
  pub chat: claude::ChatControl,
}

pub type Shared = Arc<AppState>;

struct Config {
  port: u16,
  workspace: PathBuf,
  static_dir: Option<PathBuf>,
}

fn parse_args() -> Config {
  let mut port = std::env::var("DESIGNOTRON_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
  let mut workspace = std::env::var("DESIGNOTRON_WORKSPACE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("workspace"));
  let mut static_dir: Option<PathBuf> = std::env::var("DESIGNOTRON_STATIC").ok().map(PathBuf::from);
  let mut args = std::env::args().skip(1);
  while let Some(a) = args.next() {
    match a.as_str() {
      "--port" => port = args.next().and_then(|p| p.parse().ok()).unwrap_or(port),
      "--workspace" => workspace = args.next().map(PathBuf::from).unwrap_or(workspace),
      "--static" => static_dir = args.next().map(PathBuf::from),
      "-h" | "--help" => {
        log::info!("usage: designotron [--port 5174] [--workspace ./workspace] [--static web/dist]");
        std::process::exit(0);
      }
      other => log::warn!("ignoring unknown argument {other}"),
    }
  }
  if static_dir.is_none() {
    let candidate = PathBuf::from("web/dist");
    if candidate.join("index.html").exists() {
      static_dir = Some(candidate);
    }
  }
  Config { port, workspace, static_dir }
}

#[tokio::main]
async fn main() {
  env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
  let cfg = parse_args();
  if let Err(e) = std::fs::create_dir_all(&cfg.workspace) {
    log::error!("cannot create workspace {}: {e}", cfg.workspace.display());
    std::process::exit(1);
  }
  let workspace = cfg.workspace.canonicalize().unwrap_or(cfg.workspace.clone());
  let claude = claude::detect().await;
  match &claude.version {
    Some(v) => log::info!("found Claude Code {v} ({})", claude.bin),
    None => log::warn!("`claude` CLI not found; in-app chat needs Claude Code installed (MCP still works)"),
  }

  let state: Shared = Arc::new(AppState {
    port: cfg.port,
    headless: Headless::new(workspace.clone()),
    workspace,
    claude,
    editor: EditorLink::default(),
    chat: claude::ChatControl::default(),
  });

  let mut app = Router::new()
    .route("/bridge/ws", get(editor::ws_handler))
    .route("/bridge/status", get(status))
    .route("/mcp", post(mcp::handle).get(mcp::reject_get).delete(mcp::end_session))
    .with_state(state.clone());

  if let Some(dir) = &cfg.static_dir {
    log::info!("serving editor from {}", dir.display());
    let index = dir.join("index.html");
    app = app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
  }

  let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
  let listener = match tokio::net::TcpListener::bind(addr).await {
    Ok(l) => l,
    Err(e) => {
      log::error!("cannot listen on {addr}: {e} (is another bridge running?)");
      std::process::exit(1);
    }
  };
  log::info!("Designotron bridge on http://{addr}");
  log::info!("  editor websocket: ws://{addr}/bridge/ws");
  log::info!("  MCP for Claude Code: claude mcp add --transport http designotron http://{addr}/mcp");
  log::info!("  workspace: {}", state.workspace.display());
  if cfg.static_dir.is_some() {
    log::info!("  open the editor: http://{addr}");
  }
  let server = axum::serve(listener, app).with_graceful_shutdown(async {
    let _ = tokio::signal::ctrl_c().await;
  });
  if let Err(e) = server.await {
    log::error!("server error: {e}");
  }
}

async fn status(axum::extract::State(s): axum::extract::State<Shared>) -> Json<serde_json::Value> {
  Json(json!({
    "name": "designotron-bridge",
    "version": env!("CARGO_PKG_VERSION"),
    "editorConnected": s.editor.is_connected().await,
    "claude": { "available": s.claude.version.is_some(), "version": s.claude.version },
    "workspace": s.workspace,
    "mcp": format!("http://127.0.0.1:{}/mcp", s.port),
  }))
}
