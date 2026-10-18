//! Request origin checks. The bridge can run the user's Claude Code with file
//! write access, so only local pages may drive it (no DNS rebinding, no
//! drive-by websites).

use axum::http::HeaderMap;

/// Extra allowed origins, comma separated (e.g. a hosted copy of the editor).
const ALLOWED_ORIGINS_ENV: &str = "DESIGNOTRON_ALLOWED_ORIGINS";

pub fn origin_allowed(headers: &HeaderMap) -> bool {
  let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else {
    // Non-browser clients (Claude Code, curl) send no Origin.
    return true;
  };
  if is_local_url(origin) {
    return true;
  }
  std::env::var(ALLOWED_ORIGINS_ENV)
    .map(|list| list.split(',').map(str::trim).any(|o| !o.is_empty() && o == origin))
    .unwrap_or(false)
}

pub fn host_allowed(headers: &HeaderMap) -> bool {
  let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) else {
    return false;
  };
  let name = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
  matches!(name, "localhost" | "127.0.0.1" | "[::1]")
}

fn is_local_url(origin: &str) -> bool {
  let rest = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")).unwrap_or("");
  let host = rest.split('/').next().unwrap_or("");
  let name = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
  matches!(name, "localhost" | "127.0.0.1" | "[::1]")
}

#[cfg(test)]
mod tests {
  use super::*;
  use axum::http::HeaderValue;

  fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
    let mut h = HeaderMap::new();
    for (k, v) in pairs {
      h.insert(*k, HeaderValue::from_static(v));
    }
    h
  }

  #[test]
  fn origins() {
    assert!(origin_allowed(&headers(&[])));
    assert!(origin_allowed(&headers(&[("origin", "http://localhost:5173")])));
    assert!(origin_allowed(&headers(&[("origin", "http://127.0.0.1:5174")])));
    assert!(!origin_allowed(&headers(&[("origin", "https://evil.example")])));
    assert!(!origin_allowed(&headers(&[("origin", "http://localhost.evil.example")])));
  }

  #[test]
  fn hosts() {
    assert!(host_allowed(&headers(&[("host", "127.0.0.1:5174")])));
    assert!(host_allowed(&headers(&[("host", "localhost:5174")])));
    assert!(!host_allowed(&headers(&[("host", "attacker.example:5174")])));
  }
}
