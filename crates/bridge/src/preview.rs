//! Live app preview: runs the workspace app's dev server (`npm run dev`) and
//! streams its state and logs to the editor, and writes the generated project
//! into the workspace so there is something to run.

use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;

use base64::Engine as _;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::Shared;

const MAX_LOG_LINES: usize = 400;
/// Where "Write design to workspace" puts the generated project.
pub const APP_DIR: &str = "app";

#[derive(Default)]
pub struct Preview {
  inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
  child: Option<Child>,
  /// Bumped on every start/stop so stale reader tasks can tell they are stale.
  run: u64,
  phase: Phase,
  url: Option<String>,
  dir: Option<PathBuf>,
  logs: VecDeque<String>,
}

#[derive(Default, Clone, Copy, PartialEq, Debug)]
enum Phase {
  #[default]
  Stopped,
  Installing,
  Starting,
  Running,
  Failed,
}

impl Phase {
  fn as_str(self) -> &'static str {
    match self {
      Phase::Stopped => "stopped",
      Phase::Installing => "installing",
      Phase::Starting => "starting",
      Phase::Running => "running",
      Phase::Failed => "failed",
    }
  }
}

impl Preview {
  /// Current state for the editor, including recent logs.
  pub async fn status(&self, workspace: &Path) -> Value {
    let g = self.inner.lock().await;
    let project = g.dir.clone().or_else(|| find_project(workspace));
    json!({
      "type": "preview",
      "phase": g.phase.as_str(),
      "url": g.url,
      "project": project,
      "logs": g.logs.iter().collect::<Vec<_>>(),
    })
  }
}

async fn broadcast(state: &Shared) {
  let msg = state.preview.status(&state.workspace).await;
  state.editor.send(msg).await;
}

async fn log_line(state: &Shared, run: u64, line: String) {
  let clean = strip_ansi(&line);
  let mut g = state.preview.inner.lock().await;
  if g.run != run {
    return;
  }
  if g.url.is_none() {
    if let Some(url) = find_url(&clean) {
      g.url = Some(url);
      g.phase = Phase::Running;
      drop(g);
      broadcast(state).await;
      g = state.preview.inner.lock().await;
    }
  }
  if g.logs.len() >= MAX_LOG_LINES {
    g.logs.pop_front();
  }
  g.logs.push_back(clean.clone());
  drop(g);
  state.editor.send(json!({ "type": "preview_log", "line": clean })).await;
}

async fn set_phase(state: &Shared, run: u64, phase: Phase, message: Option<String>) {
  {
    let mut g = state.preview.inner.lock().await;
    if g.run != run {
      return;
    }
    g.phase = phase;
    if let Some(m) = message {
      g.logs.push_back(m);
    }
  }
  broadcast(state).await;
}

/// Starts `npm install` (when needed) and `npm run dev` in the workspace app.
pub async fn start(state: Shared) {
  let run = {
    let mut g = state.preview.inner.lock().await;
    if matches!(g.phase, Phase::Installing | Phase::Starting | Phase::Running) {
      drop(g);
      broadcast(&state).await;
      return;
    }
    g.run += 1;
    g.logs.clear();
    g.url = None;
    g.dir = find_project(&state.workspace);
    g.phase = if g.dir.is_some() { Phase::Starting } else { Phase::Failed };
    if g.dir.is_none() {
      g.logs
        .push_back("No app in the workspace yet. Click \"Write design to workspace\" or ask Claude to build the app.".into());
    }
    g.run
  };
  broadcast(&state).await;
  let Some(dir) = state.preview.inner.lock().await.dir.clone() else {
    return;
  };

  if !dir.join("node_modules").exists() {
    set_phase(&state, run, Phase::Installing, Some("$ npm install".into())).await;
    match spawn(&dir, &["install", "--no-fund", "--no-audit"]) {
      Ok(mut child) => {
        pipe_logs(&state, run, &mut child);
        state.preview.inner.lock().await.child = Some(child);
        let status = wait_current(&state, run).await;
        if state.preview.inner.lock().await.run != run {
          return;
        }
        if status != Some(true) {
          set_phase(&state, run, Phase::Failed, Some("npm install failed".into())).await;
          return;
        }
      }
      Err(e) => {
        set_phase(&state, run, Phase::Failed, Some(e)).await;
        return;
      }
    }
  }

  set_phase(&state, run, Phase::Starting, Some("$ npm run dev".into())).await;
  match spawn(&dir, &["run", "dev"]) {
    Ok(mut child) => {
      pipe_logs(&state, run, &mut child);
      state.preview.inner.lock().await.child = Some(child);
      let status = wait_current(&state, run).await;
      if state.preview.inner.lock().await.run == run {
        let msg = format!("dev server exited ({})", if status == Some(true) { "ok" } else { "error" });
        state.preview.inner.lock().await.url = None;
        set_phase(&state, run, Phase::Failed, Some(msg)).await;
      }
    }
    Err(e) => set_phase(&state, run, Phase::Failed, Some(e)).await,
  }
}

/// Waits for the current child to exit without holding the lock.
async fn wait_current(state: &Shared, run: u64) -> Option<bool> {
  loop {
    {
      let mut g = state.preview.inner.lock().await;
      if g.run != run {
        return None;
      }
      match g.child.as_mut().map(|c| c.try_wait()) {
        Some(Ok(Some(status))) => {
          g.child = None;
          return Some(status.success());
        }
        Some(Ok(None)) => {}
        _ => return None,
      }
    }
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
  }
}

pub async fn stop(state: Shared) {
  let child = {
    let mut g = state.preview.inner.lock().await;
    g.run += 1;
    g.phase = Phase::Stopped;
    g.url = None;
    g.child.take()
  };
  if let Some(c) = child {
    kill_tree(c).await;
  }
  broadcast(&state).await;
}

fn spawn(dir: &Path, args: &[&str]) -> Result<Child, String> {
  let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
  let mut cmd = Command::new(npm);
  cmd
    .args(args)
    .current_dir(dir)
    .env("BROWSER", "none")
    .env("NO_COLOR", "1")
    .env("FORCE_COLOR", "0")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
  #[cfg(unix)]
  cmd.process_group(0);
  cmd
    .spawn()
    .map_err(|e| format!("could not run npm ({e}). Install Node.js 18+ to preview the app."))
}

fn pipe_logs(state: &Shared, run: u64, child: &mut Child) {
  fn reader<R: AsyncRead + Unpin + Send + 'static>(state: Shared, run: u64, r: R) {
    tokio::spawn(async move {
      let mut lines = BufReader::new(r).lines();
      while let Ok(Some(line)) = lines.next_line().await {
        log_line(&state, run, line).await;
      }
    });
  }
  if let Some(out) = child.stdout.take() {
    reader(state.clone(), run, out);
  }
  if let Some(err) = child.stderr.take() {
    reader(state.clone(), run, err);
  }
}

/// `npm run dev` spawns a shell and node; kill the whole process group.
async fn kill_tree(mut child: Child) {
  if let Some(pid) = child.id() {
    #[cfg(unix)]
    let _ = Command::new("kill").args(["-TERM", "--", &format!("-{pid}")]).status().await;
    #[cfg(windows)]
    let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).status().await;
  }
  let _ = child.kill().await;
}

/// The app to run: the workspace itself, `workspace/app`, or the first subfolder with a `dev` script.
pub fn find_project(workspace: &Path) -> Option<PathBuf> {
  let has_dev = |dir: &Path| -> bool {
    std::fs::read_to_string(dir.join("package.json"))
      .ok()
      .and_then(|s| serde_json::from_str::<Value>(&s).ok())
      .map(|v| v["scripts"]["dev"].is_string())
      .unwrap_or(false)
  };
  if has_dev(workspace) {
    return Some(workspace.to_path_buf());
  }
  let app = workspace.join(APP_DIR);
  if has_dev(&app) {
    return Some(app);
  }
  let mut dirs: Vec<PathBuf> = std::fs::read_dir(workspace)
    .ok()?
    .flatten()
    .map(|e| e.path())
    .filter(|p| p.is_dir())
    .filter(|p| {
      let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
      !name.starts_with('.') && name != "node_modules"
    })
    .collect();
  dirs.sort();
  dirs.into_iter().find(|d| has_dev(d))
}

/// Writes generated project files under `workspace/app`, skipping unchanged files.
/// `files` are `{path, content}`; `binaries` are `{path, data}` with base64 data.
pub fn write_project(workspace: &Path, files: &[Value], binaries: &[Value]) -> Result<usize, String> {
  let root = workspace.join(APP_DIR);
  let mut written = 0;
  let mut put = |rel: &str, bytes: Vec<u8>| -> Result<(), String> {
    let path = safe_join(&root, rel).ok_or_else(|| format!("refusing to write outside the app folder: {rel}"))?;
    if std::fs::read(&path).map(|old| old == bytes).unwrap_or(false) {
      return Ok(());
    }
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    written += 1;
    Ok(())
  };
  for f in files {
    let (Some(p), Some(c)) = (f["path"].as_str(), f["content"].as_str()) else {
      continue;
    };
    put(p, c.as_bytes().to_vec())?;
  }
  for b in binaries {
    let (Some(p), Some(d)) = (b["path"].as_str(), b["data"].as_str()) else {
      continue;
    };
    let bytes = base64::engine::general_purpose::STANDARD
      .decode(d)
      .map_err(|e| format!("{p}: {e}"))?;
    put(p, bytes)?;
  }
  Ok(written)
}

/// Joins a relative path, rejecting absolute paths and `..`.
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
  let rel = Path::new(rel);
  if rel.components().all(|c| matches!(c, Component::Normal(_))) && rel.components().next().is_some() {
    Some(root.join(rel))
  } else {
    None
  }
}

fn strip_ansi(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  let mut chars = s.chars().peekable();
  while let Some(c) = chars.next() {
    if c == '\u{1b}' {
      if chars.peek() == Some(&'[') {
        chars.next();
        for n in chars.by_ref() {
          if n.is_ascii_alphabetic() {
            break;
          }
        }
      }
      continue;
    }
    out.push(c);
  }
  out
}

/// First local http URL in a dev server log line ("Local: http://localhost:5173/").
fn find_url(line: &str) -> Option<String> {
  for prefix in ["http://localhost:", "http://127.0.0.1:"] {
    if let Some(i) = line.find(prefix) {
      let url: String = line[i..].chars().take_while(|c| !c.is_whitespace()).collect();
      return Some(url);
    }
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_dev_server_urls() {
    let line =
      strip_ansi("  \u{1b}[32m➜\u{1b}[39m  \u{1b}[1mLocal\u{1b}[22m:   \u{1b}[36mhttp://localhost:\u{1b}[1m5175\u{1b}[22m/\u{1b}[39m");
    assert_eq!(find_url(&line).as_deref(), Some("http://localhost:5175/"));
    assert_eq!(
      find_url("ready - started server on http://127.0.0.1:3000").as_deref(),
      Some("http://127.0.0.1:3000")
    );
    assert_eq!(find_url("compiling..."), None);
  }

  #[test]
  fn rejects_paths_outside_the_app() {
    let root = Path::new("/w/app");
    assert!(safe_join(root, "src/App.tsx").is_some());
    assert!(safe_join(root, "../secret").is_none());
    assert!(safe_join(root, "/etc/passwd").is_none());
    assert!(safe_join(root, "").is_none());
  }

  #[test]
  fn writes_project_and_finds_it() {
    let ws = std::env::temp_dir().join(format!("dt-preview-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&ws);
    std::fs::create_dir_all(&ws).unwrap();
    assert!(find_project(&ws).is_none());
    let files = [
      json!({ "path": "package.json", "content": "{\"scripts\":{\"dev\":\"vite\"}}" }),
      json!({ "path": "src/App.tsx", "content": "export default 1" }),
    ];
    assert_eq!(write_project(&ws, &files, &[]).unwrap(), 2);
    assert_eq!(write_project(&ws, &files, &[]).unwrap(), 0, "unchanged files are not rewritten");
    assert_eq!(find_project(&ws), Some(ws.join(APP_DIR)));
    assert!(write_project(&ws, &[json!({ "path": "../x", "content": "" })], &[]).is_err());
    let _ = std::fs::remove_dir_all(ws);
  }
}
