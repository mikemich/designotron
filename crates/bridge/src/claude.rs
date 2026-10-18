//! In-app chat backed by the user's own Claude Code CLI. The bridge spawns
//! `claude -p` with this server as an MCP server, so chat uses whatever the
//! CLI is signed in with (Claude Pro/Max subscription or an API key).

use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::Shared;

const CLAUDE_BIN_ENV: &str = "CLAUDE_BIN";
/// Extra `--allowedTools` entries, comma separated.
const ALLOWED_TOOLS_ENV: &str = "DESIGNOTRON_ALLOWED_TOOLS";

/// Tools Claude Code may use without prompting during in-app chat.
const DEFAULT_ALLOWED_TOOLS: &[&str] = &[
  "mcp__designotron",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Bash(node:*)",
  "Bash(ls:*)",
  "Bash(mkdir:*)",
  "Bash(cat:*)",
];

pub struct ClaudeInfo {
  pub bin: String,
  pub version: Option<String>,
}

pub async fn detect() -> ClaudeInfo {
  let bin = std::env::var(CLAUDE_BIN_ENV).unwrap_or_else(|_| "claude".into());
  let probe = Command::new(&bin)
    .arg("--version")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .output();
  let version = match tokio::time::timeout(Duration::from_secs(10), probe).await {
    Ok(Ok(out)) if out.status.success() => {
      let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
      Some(s.split_whitespace().next().unwrap_or(&s).to_string())
    }
    _ => None,
  };
  ClaudeInfo { bin, version }
}

#[derive(Default)]
pub struct ChatControl {
  child: Mutex<Option<Child>>,
}

impl ChatControl {
  pub async fn cancel(&self) {
    if let Some(mut c) = self.child.lock().await.take() {
      let _ = c.kill().await;
    }
  }
}

/// Runs one chat turn and streams Claude Code's `stream-json` events to the editor.
/// Runs one chat turn. Images go to Claude Code as image blocks of a stream-json user
/// message (so it sees them directly); otherwise the prompt is a plain argument.
/// `turn` is the editor's number for this message, echoed in chat_done/chat_error so a late
/// reply from an earlier turn can't end the current one.
pub async fn run_chat(state: Shared, prompt: String, session: Option<String>, images: Vec<crate::fetch::ChatImage>, turn: u64) {
  if state.claude.version.is_none() {
    state
      .editor
      .send(json!({ "type": "chat_error", "turn": turn, "message": "Claude Code CLI not found. Install it and sign in (`claude`, then /login)." }))
      .await;
    return;
  }
  state.chat.cancel().await;

  let mcp_config = json!({ "mcpServers": { "designotron": { "type": "http", "url": format!("http://127.0.0.1:{}/mcp", state.port) } } });
  let config_path = std::env::temp_dir().join(format!("designotron-mcp-{}.json", state.port));
  if let Err(e) = tokio::fs::write(&config_path, mcp_config.to_string()).await {
    state
      .editor
      .send(json!({ "type": "chat_error", "turn": turn, "message": format!("could not write MCP config: {e}") }))
      .await;
    return;
  }

  let mut allowed: Vec<String> = DEFAULT_ALLOWED_TOOLS.iter().map(|s| s.to_string()).collect();
  if let Ok(extra) = std::env::var(ALLOWED_TOOLS_ENV) {
    allowed.extend(extra.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
  }
  let system = format!(
    "{}\n\nYou are running inside Designotron's chat panel. The open design is available through the mcp__designotron__* tools; \
     use them for anything about the design (read with get_document / get_nodes, verify with get_screenshot). \
     Your working directory ({}) is where application code goes when the user asks you to build the design for real; \
     prefer the `app/` folder, which the editor's App tab runs with `npm run dev` as a live preview next to the design. \
     Keep replies short; the user watches the canvas update live.",
    designotron_engine::ai::SYSTEM_PROMPT,
    state.workspace.display()
  );

  let mut cmd = Command::new(&state.claude.bin);
  cmd.arg("-p");
  if images.is_empty() {
    cmd.arg(&prompt);
  } else {
    cmd.args(["--input-format", "stream-json"]);
  }
  cmd
    .args(["--output-format", "stream-json", "--verbose", "--include-partial-messages"])
    .arg("--mcp-config")
    .arg(&config_path)
    .arg("--permission-mode")
    .arg("acceptEdits")
    .arg("--append-system-prompt")
    .arg(&system)
    .arg("--allowedTools")
    .args(&allowed);
  if let Some(s) = &session {
    cmd.arg("--resume").arg(s);
  }
  cmd
    .current_dir(&state.workspace)
    .stdin(if images.is_empty() { Stdio::null() } else { Stdio::piped() })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);

  let mut child = match cmd.spawn() {
    Ok(c) => c,
    Err(e) => {
      state
        .editor
        .send(json!({ "type": "chat_error", "turn": turn, "message": format!("could not start Claude Code: {e}") }))
        .await;
      return;
    }
  };
  if let Some(mut stdin) = child.stdin.take() {
    let mut content = vec![json!({ "type": "text", "text": prompt })];
    content.extend(
      images
        .iter()
        .map(|i| json!({ "type": "image", "source": { "type": "base64", "media_type": i.media_type, "data": i.data } })),
    );
    let line = json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string() + "\n";
    // Closing stdin afterwards ends the input: one message per turn.
    if let Err(e) = stdin.write_all(line.as_bytes()).await {
      log::warn!("could not send the message to Claude Code: {e}");
    }
  }
  let stdout = child.stdout.take();
  let stderr = child.stderr.take();
  *state.chat.child.lock().await = Some(child);

  let stderr_task = tokio::spawn(async move {
    let mut buf = String::new();
    if let Some(mut e) = stderr {
      let _ = e.read_to_string(&mut buf).await;
    }
    buf
  });

  let mut session_id = session.clone();
  if let Some(out) = stdout {
    let mut lines = BufReader::new(out).lines();
    while let Ok(Some(line)) = lines.next_line().await {
      let Ok(event) = serde_json::from_str::<Value>(&line) else {
        continue;
      };
      if let Some(s) = event["session_id"].as_str() {
        session_id = Some(s.to_string());
      }
      let done = event["type"] == "result";
      state.editor.send(json!({ "type": "chat_event", "event": event })).await;
      // The result ends the turn; newer CLIs can keep running for a while afterwards.
      if done {
        break;
      }
    }
  }

  let status = match state.chat.child.lock().await.take() {
    Some(mut c) => match tokio::time::timeout(std::time::Duration::from_secs(3), c.wait()).await {
      Ok(s) => s.ok(),
      Err(_) => {
        // Still running after its result: stop it (the turn is complete).
        let _ = c.kill().await;
        c.wait().await.ok().map(|_| std::process::ExitStatus::default())
      }
    },
    None => None,
  };
  let stderr_text = stderr_task.await.unwrap_or_default();
  match status {
    Some(s) if !s.success() => {
      let tail: String = stderr_text
        .lines()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
      let message = if tail.is_empty() {
        format!("Claude Code exited with {s}")
      } else {
        tail
      };
      state
        .editor
        .send(json!({ "type": "chat_error", "turn": turn, "message": message }))
        .await;
    }
    None => {
      state.editor.send(json!({ "type": "log", "message": "Stopped." })).await;
    }
    _ => {}
  }
  state
    .editor
    .send(json!({ "type": "chat_done", "turn": turn, "sessionId": session_id }))
    .await;
}
