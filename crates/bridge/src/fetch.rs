//! Server-side page fetch for "import a website", and saving chat attachments
//! where Claude Code can read them.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::Value;

use crate::Shared;

const MAX_PAGE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 15 * 1024 * 1024;

/// HTTP client honouring HTTPS_PROXY/NO_PROXY and the OS certificate store (corporate
/// proxies, custom CAs). Loopback addresses never go through a proxy.
fn agent(url: &str, timeout: Duration) -> ureq::Agent {
  let builder = ureq::AgentBuilder::new().timeout(timeout).redirects(5);
  if bypass_proxy(url) {
    builder.build()
  } else {
    builder.try_proxy_from_env(true).build()
  }
}

/// Host part of an http(s) URL, without userinfo, port or IPv6 brackets.
fn host_of(url: &str) -> &str {
  let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
  let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
  let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
  if let Some(v6) = host.strip_prefix('[') {
    return v6.split(']').next().unwrap_or(v6);
  }
  host.split(':').next().unwrap_or(host)
}

fn bypass_proxy(url: &str) -> bool {
  let host = host_of(url);
  if host == "localhost" || host.starts_with("127.") || host == "::1" || host.ends_with(".localhost") {
    return true;
  }
  let no_proxy = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")).unwrap_or_default();
  no_proxy.split(',').map(str::trim).filter(|e| !e.is_empty()).any(|e| {
    let e = e.trim_start_matches('.');
    e == "*" || host == e || host.ends_with(&format!(".{e}"))
  })
}

#[derive(Deserialize)]
pub struct FetchParams {
  url: String,
}

/// `GET /bridge/fetch?url=…` returns the page's HTML (http/https only).
pub async fn fetch_page(State(_state): State<Shared>, headers: HeaderMap, Query(p): Query<FetchParams>) -> Response {
  if !crate::security::origin_allowed(&headers) || !crate::security::host_allowed(&headers) {
    return (StatusCode::FORBIDDEN, "forbidden").into_response();
  }
  if !(p.url.starts_with("http://") || p.url.starts_with("https://")) {
    return (StatusCode::BAD_REQUEST, "only http and https URLs can be imported").into_response();
  }
  let url = p.url.clone();
  let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
    let agent = agent(&url, Duration::from_secs(20));
    let res = agent
      .get(&url)
      .set("User-Agent", "Mozilla/5.0 (Designotron import)")
      .set("Accept", "text/html,application/xhtml+xml")
      .call()
      .map_err(|e| format!("could not fetch {url}: {e}"))?;
    let mut body = String::new();
    res
      .into_reader()
      .take(MAX_PAGE_BYTES)
      .read_to_string(&mut body)
      .map_err(|e| format!("could not read {url}: {e}"))?;
    Ok(body)
  })
  .await;
  match result {
    Ok(Ok(html)) => (
      [
        (header::CONTENT_TYPE, "text/html; charset=utf-8"),
        (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
      ],
      html,
    )
      .into_response(),
    Ok(Err(e)) => (StatusCode::BAD_GATEWAY, e).into_response(),
    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
  }
}

/// An image attached to a chat message, passed to Claude Code as an image content block.
pub struct ChatImage {
  pub media_type: &'static str,
  /// Base64, already checked to decode and fit the size limit.
  pub data: String,
}

/// The attachments Claude can see directly: images in a supported format and under the size limit.
pub fn chat_images(attachments: &[Value]) -> Vec<ChatImage> {
  attachments
    .iter()
    .filter_map(|a| {
      let media_type = match a["mediaType"].as_str().unwrap_or("image/png") {
        "image/png" => "image/png",
        "image/jpeg" => "image/jpeg",
        "image/gif" => "image/gif",
        "image/webp" => "image/webp",
        _ => return None,
      };
      let data = a["data"].as_str()?;
      let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
      (bytes.len() <= MAX_ATTACHMENT_BYTES).then(|| ChatImage {
        media_type,
        data: data.to_string(),
      })
    })
    .collect()
}

/// Writes base64 attachments into the workspace and returns their absolute paths.
pub fn save_attachments(workspace: &Path, attachments: &[Value]) -> Vec<PathBuf> {
  let dir = workspace.join(".designotron").join("attachments");
  if std::fs::create_dir_all(&dir).is_err() {
    return vec![];
  }
  let stamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0);
  let mut out = Vec::new();
  for (i, a) in attachments.iter().enumerate() {
    let Some(data) = a["data"].as_str() else { continue };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else {
      continue;
    };
    if bytes.len() > MAX_ATTACHMENT_BYTES {
      continue;
    }
    let ext = match a["mediaType"].as_str().unwrap_or("image/png") {
      "image/jpeg" => "jpg",
      "image/gif" => "gif",
      "image/webp" => "webp",
      _ => "png",
    };
    let path = dir.join(format!("{stamp}-{i}.{ext}"));
    if std::fs::write(&path, bytes).is_ok() {
      out.push(path);
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn loopback_skips_the_proxy() {
    assert!(bypass_proxy("http://127.0.0.1:5199/"));
    assert!(bypass_proxy("http://localhost/x"));
    assert!(bypass_proxy("http://[::1]:8080/"));
    assert!(!bypass_proxy("https://api.figma.com/v1/files/x"));
  }

  #[test]
  fn chat_images_keep_supported_images_only() {
    let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG fake");
    let images = chat_images(&[
      json!({ "mediaType": "image/png", "data": png }),
      json!({ "mediaType": "image/svg+xml", "data": png }),
      json!({ "mediaType": "image/jpeg", "data": "not base64!!" }),
      json!({ "data": png }),
    ]);
    assert_eq!(images.iter().map(|i| i.media_type).collect::<Vec<_>>(), ["image/png", "image/png"]);
  }

  #[test]
  fn saves_valid_attachments_and_skips_bad_ones() {
    let dir = std::env::temp_dir().join(format!("dt-attach-{}", std::process::id()));
    let png = base64::engine::general_purpose::STANDARD.encode([0x89, b'P', b'N', b'G']);
    let paths = save_attachments(
      &dir,
      &[
        json!({ "data": png, "mediaType": "image/png" }),
        json!({ "data": "not base64!!", "mediaType": "image/png" }),
        json!({ "data": png, "mediaType": "image/jpeg" }),
      ],
    );
    assert_eq!(paths.len(), 2);
    assert!(paths[0].extension().unwrap() == "png" && paths[1].extension().unwrap() == "jpg");
    assert_eq!(std::fs::read(&paths[0]).unwrap(), [0x89, b'P', b'N', b'G']);
    let _ = std::fs::remove_dir_all(dir);
  }
}

#[derive(Deserialize)]
pub struct FigmaParams {
  /// API path after `/v1/`, e.g. `files/KEY` or `files/KEY/images`.
  path: String,
  #[serde(default)]
  query: String,
  /// Personal access token; a query parameter keeps the request "simple" (no CORS preflight).
  #[serde(default)]
  token: String,
}

/// `GET /bridge/figma?path=files/KEY&query=geometry=paths&token=…` proxies the Figma REST API.
pub async fn figma_api(State(_state): State<Shared>, headers: HeaderMap, Query(p): Query<FigmaParams>) -> Response {
  if !crate::security::origin_allowed(&headers) || !crate::security::host_allowed(&headers) {
    return (StatusCode::FORBIDDEN, "forbidden").into_response();
  }
  let ok_path = p.path.starts_with("files/") && p.path.chars().all(|c| c.is_ascii_alphanumeric() || "/_-:".contains(c));
  let ok_query = p.query.chars().all(|c| c.is_ascii_alphanumeric() || "=&,:_-%;".contains(c));
  if !ok_path || !ok_query {
    return (StatusCode::BAD_REQUEST, "unsupported Figma API path").into_response();
  }
  let token = headers
    .get("x-figma-token")
    .and_then(|v| v.to_str().ok())
    .map(String::from)
    .unwrap_or(p.token.clone());
  if token.is_empty() {
    return (StatusCode::BAD_REQUEST, "missing Figma token").into_response();
  }
  let url = if p.query.is_empty() {
    format!("https://api.figma.com/v1/{}", p.path)
  } else {
    format!("https://api.figma.com/v1/{}?{}", p.path, p.query)
  };
  let result = tokio::task::spawn_blocking(move || -> Result<(u16, String), String> {
    let agent = agent(&url, Duration::from_secs(120));
    let res = match agent.get(&url).set("X-Figma-Token", &token).call() {
      Ok(r) => r,
      Err(ureq::Error::Status(code, r)) => return Ok((code, r.into_string().unwrap_or_default())),
      Err(e) => return Err(format!("could not reach the Figma API: {e}")),
    };
    let mut body = String::new();
    res
      .into_reader()
      .take(200 * 1024 * 1024)
      .read_to_string(&mut body)
      .map_err(|e| e.to_string())?;
    Ok((200, body))
  })
  .await;
  match result {
    Ok(Ok((code, body))) => (
      StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY),
      [
        (header::CONTENT_TYPE, "application/json"),
        (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
      ],
      body,
    )
      .into_response(),
    Ok(Err(e)) => (StatusCode::BAD_GATEWAY, e).into_response(),
    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
  }
}
