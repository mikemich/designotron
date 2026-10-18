//! `designotron service install|uninstall|status`: runs the bridge in the background at
//! login (launchd on macOS, a systemd user unit on Linux), so the hosted editor finds
//! Claude without a terminal open.
//!
//! The service gets the PATH of the shell that installed it, because login services
//! start with a minimal PATH that usually lacks `claude` and `node`.

use std::path::{Path, PathBuf};
use std::process::Command;

const LABEL: &str = "com.designotron.bridge";
const UNIT: &str = "designotron.service";

pub fn run(args: &[String]) -> i32 {
  let result = match args.first().map(String::as_str) {
    Some("install") => install(workspace_arg(&args[1..])),
    Some("uninstall") => uninstall(),
    Some("status") => status(),
    _ => {
      eprintln!("usage: designotron service install [--workspace ~/Designotron] | uninstall | status");
      return 2;
    }
  };
  match result {
    Ok(()) => 0,
    Err(e) => {
      eprintln!("designotron: {e}");
      1
    }
  }
}

fn workspace_arg(args: &[String]) -> Option<PathBuf> {
  let i = args.iter().position(|a| a == "--workspace")?;
  args.get(i + 1).map(PathBuf::from)
}

fn home() -> Result<PathBuf, String> {
  std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME is not set".into())
}

fn sh(cmd: &str, args: &[&str]) -> Result<(), String> {
  let out = Command::new(cmd)
    .args(args)
    .output()
    .map_err(|e| format!("cannot run {cmd}: {e}"))?;
  if out.status.success() {
    Ok(())
  } else {
    Err(format!(
      "{cmd} {} failed: {}",
      args.join(" "),
      String::from_utf8_lossy(&out.stderr).trim()
    ))
  }
}

fn install(workspace: Option<PathBuf>) -> Result<(), String> {
  let exe = std::env::current_exe()
    .and_then(|p| p.canonicalize())
    .map_err(|e| format!("cannot find this program's path: {e}"))?;
  let workspace = match workspace {
    Some(w) => w,
    None => home()?.join("Designotron"),
  };
  std::fs::create_dir_all(&workspace).map_err(|e| format!("cannot create {}: {e}", workspace.display()))?;
  let workspace = workspace.canonicalize().unwrap_or(workspace);
  let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into());
  if cfg!(target_os = "macos") {
    install_launchd(&exe, &workspace, &path)?;
  } else if cfg!(target_os = "linux") {
    install_systemd(&exe, &workspace, &path)?;
  } else {
    return Err("background service isn't supported on this OS yet; run designotron and leave it open".into());
  }
  println!("Designotron now runs in the background and starts when you log in.");
  println!("  workspace: {}", workspace.display());
  println!("  editor:    http://127.0.0.1:{} (or the hosted editor)", crate::DEFAULT_PORT);
  println!("  stop it:   designotron service uninstall");
  Ok(())
}

fn uninstall() -> Result<(), String> {
  if cfg!(target_os = "macos") {
    let plist = plist_path()?;
    let _ = sh("launchctl", &["bootout", &launchd_domain()?, &plist.to_string_lossy()]);
    let _ = std::fs::remove_file(&plist);
  } else if cfg!(target_os = "linux") {
    let _ = sh("systemctl", &["--user", "disable", "--now", UNIT]);
    let _ = std::fs::remove_file(unit_path()?);
    let _ = sh("systemctl", &["--user", "daemon-reload"]);
  } else {
    return Err("no background service on this OS".into());
  }
  println!("Designotron no longer runs in the background.");
  Ok(())
}

fn status() -> Result<(), String> {
  let installed = if cfg!(target_os = "macos") {
    plist_path()?.exists()
  } else if cfg!(target_os = "linux") {
    unit_path()?.exists()
  } else {
    false
  };
  let running = crate::bridge_running(crate::DEFAULT_PORT);
  println!("service installed: {}", if installed { "yes" } else { "no" });
  println!(
    "bridge running on 127.0.0.1:{}: {}",
    crate::DEFAULT_PORT,
    if running { "yes" } else { "no" }
  );
  if cfg!(target_os = "macos") && installed {
    println!("log: {}", log_path()?.display());
  } else if installed {
    println!("log: journalctl --user -u {UNIT}");
  }
  Ok(())
}

// ---------- macOS ----------

fn plist_path() -> Result<PathBuf, String> {
  Ok(home()?.join("Library/LaunchAgents").join(format!("{LABEL}.plist")))
}

fn log_path() -> Result<PathBuf, String> {
  Ok(home()?.join("Library/Logs/Designotron/bridge.log"))
}

fn launchd_domain() -> Result<String, String> {
  let out = Command::new("id").arg("-u").output().map_err(|e| format!("cannot run id: {e}"))?;
  Ok(format!("gui/{}", String::from_utf8_lossy(&out.stdout).trim()))
}

fn xml(s: &str) -> String {
  s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn install_launchd(exe: &Path, workspace: &Path, path: &str) -> Result<(), String> {
  let plist = plist_path()?;
  let log = log_path()?;
  for dir in [plist.parent(), log.parent()].into_iter().flatten() {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
  }
  let body = format!(
    r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>--no-open</string>
    <string>--workspace</string>
    <string>{ws}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>{path}</string>
  </dict>
  <key>WorkingDirectory</key><string>{ws}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
    exe = xml(&exe.to_string_lossy()),
    ws = xml(&workspace.to_string_lossy()),
    path = xml(path),
    log = xml(&log.to_string_lossy()),
  );
  std::fs::write(&plist, body).map_err(|e| format!("cannot write {}: {e}", plist.display()))?;
  let domain = launchd_domain()?;
  // Reinstalling (e.g. after an update) restarts it with the new binary.
  let _ = sh("launchctl", &["bootout", &domain, &plist.to_string_lossy()]);
  sh("launchctl", &["bootstrap", &domain, &plist.to_string_lossy()])
}

// ---------- Linux ----------

fn unit_path() -> Result<PathBuf, String> {
  let base = std::env::var_os("XDG_CONFIG_HOME")
    .map(PathBuf::from)
    .map_or_else(|| home().map(|h| h.join(".config")), Ok)?;
  Ok(base.join("systemd/user").join(UNIT))
}

/// Quotes a value for a systemd unit line.
fn unit_quote(s: &str) -> String {
  format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"").replace('%', "%%"))
}

fn install_systemd(exe: &Path, workspace: &Path, path: &str) -> Result<(), String> {
  let unit = unit_path()?;
  if let Some(dir) = unit.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
  }
  let body = format!(
    "[Unit]\nDescription=Designotron bridge (editor + Claude Code)\n\n[Service]\nExecStart={} --no-open --workspace {}\nEnvironment={}\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n",
    unit_quote(&exe.to_string_lossy()),
    unit_quote(&workspace.to_string_lossy()),
    unit_quote(&format!("PATH={path}")),
  );
  std::fs::write(&unit, body).map_err(|e| format!("cannot write {}: {e}", unit.display()))?;
  sh("systemctl", &["--user", "daemon-reload"])?;
  sh("systemctl", &["--user", "enable", UNIT])?;
  sh("systemctl", &["--user", "restart", UNIT])
}
