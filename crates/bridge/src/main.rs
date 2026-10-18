//! Designotron bridge: a local server that
//! - serves the built editor (`web/dist`) when present,
//! - relays tool calls between Claude Code (MCP over HTTP) and the open editor,
//! - runs the user's own `claude` CLI for in-app chat (Pro/Max or API key login),
//! - falls back to a native engine on `workspace/design.dtron.json` when no editor is open.

mod claude;
mod collab;
mod editor;
mod fetch;
mod headless;
mod mcp;
mod preview;
mod security;
mod service;
mod web;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use crate::claude::ClaudeInfo;
use crate::editor::EditorLink;
use crate::headless::Headless;

const DEFAULT_PORT: u16 = 5174;

/// Whether a Designotron bridge already answers on this port (e.g. the background service).
fn bridge_running(port: u16) -> bool {
  ureq::AgentBuilder::new()
    .timeout(std::time::Duration::from_secs(2))
    .build()
    .get(&format!("http://127.0.0.1:{port}/bridge/status"))
    .call()
    .ok()
    .and_then(|r| r.into_string().ok())
    .is_some_and(|body| body.contains("designotron-bridge"))
}

pub struct AppState {
  pub port: u16,
  pub workspace: PathBuf,
  pub claude: ClaudeInfo,
  pub editor: EditorLink,
  pub headless: Headless,
  pub chat: claude::ChatControl,
  pub preview: preview::Preview,
  pub collab: collab::Collab,
  /// Editor build to serve (also used by the share listener).
  pub static_dir: Option<PathBuf>,
}

pub type Shared = Arc<AppState>;

struct Config {
  port: u16,
  workspace: PathBuf,
  static_dir: Option<PathBuf>,
  open: bool,
}

fn parse_args() -> Config {
  let mut port = std::env::var("DESIGNOTRON_PORT")
    .ok()
    .and_then(|p| p.parse().ok())
    .unwrap_or(DEFAULT_PORT);
  let mut workspace = std::env::var("DESIGNOTRON_WORKSPACE")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from("workspace"));
  let mut static_dir: Option<PathBuf> = std::env::var("DESIGNOTRON_STATIC").ok().map(PathBuf::from);
  let mut open = std::env::var("DESIGNOTRON_NO_OPEN").is_err();
  let mut args = std::env::args().skip(1);
  while let Some(a) = args.next() {
    match a.as_str() {
      "--port" => port = args.next().and_then(|p| p.parse().ok()).unwrap_or(port),
      "--workspace" => workspace = args.next().map(PathBuf::from).unwrap_or(workspace),
      "--static" => static_dir = args.next().map(PathBuf::from),
      "--no-open" => open = false,
      "-V" | "--version" => {
        log::info!("designotron {}", env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
      }
      "-h" | "--help" => {
        log::info!("usage: designotron [--port 5174] [--workspace ./workspace] [--static web/dist] [--no-open]");
        log::info!("       designotron service install|uninstall|status   (run in the background at login)");
        std::process::exit(0);
      }
      other => log::warn!("ignoring unknown argument {other}"),
    }
  }
  Config {
    port,
    workspace,
    static_dir,
    open,
  }
}

#[tokio::main]
async fn main() {
  env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
  let argv: Vec<String> = std::env::args().skip(1).collect();
  if argv.first().map(String::as_str) == Some("service") {
    std::process::exit(service::run(&argv[1..]));
  }
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
    preview: preview::Preview::default(),
    collab: collab::Collab::default(),
    static_dir: cfg.static_dir.clone(),
  });

  let mut app = Router::new()
    .route("/bridge/ws", get(editor::ws_handler))
    .route("/bridge/status", get(status))
    .route("/bridge/fetch", get(fetch::fetch_page))
    .route("/bridge/figma", get(fetch::figma_api))
    .route("/bridge/share", post(collab::start_share))
    .route("/collab/ws", get(collab::owner_ws))
    .route("/mcp", post(mcp::handle).get(mcp::reject_get).delete(mcp::end_session))
    .with_state(state.clone());

  let ui = web::pick(cfg.static_dir.clone());
  let serves_ui = !matches!(ui, web::Source::None);
  app = web::mount(app, &ui);

  let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
  let listener = match tokio::net::TcpListener::bind(addr).await {
    Ok(l) => l,
    Err(e) => {
      // Usually the background service: just open the editor it serves.
      if bridge_running(cfg.port) {
        log::info!("Designotron is already running: http://{addr}");
        if cfg.open {
          web::open_browser(&format!("http://{addr}"));
        }
        std::process::exit(0);
      }
      log::error!("cannot listen on {addr}: {e}");
      std::process::exit(1);
    }
  };
  log::info!("Designotron bridge on http://{addr}");
  log::info!("  editor websocket: ws://{addr}/bridge/ws");
  log::info!("  MCP for Claude Code: claude mcp add --transport http designotron http://{addr}/mcp");
  log::info!("  workspace: {}", state.workspace.display());
  if serves_ui {
    log::info!("  open the editor: http://{addr}");
    if cfg.open {
      web::open_browser(&format!("http://{addr}"));
    }
  }
  let server = axum::serve(listener, app).with_graceful_shutdown(async {
    let _ = tokio::signal::ctrl_c().await;
  });
  if let Err(e) = server.await {
    log::error!("server error: {e}");
  }
  // Don't leave the app's dev server running after the bridge exits.
  preview::stop(state).await;
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
