//! Serving the editor: from a directory (`--static`, or `web/dist` in a checkout) or,
//! in release builds with the `embed-web` feature, from files compiled into the binary.

use std::path::PathBuf;

use axum::Router;
use tower_http::services::{ServeDir, ServeFile};

/// Where the editor UI comes from, if anywhere.
pub enum Source {
  Dir(PathBuf),
  #[cfg(feature = "embed-web")]
  Embedded,
  None,
}

pub fn pick(static_dir: Option<PathBuf>) -> Source {
  if let Some(dir) = static_dir {
    return Source::Dir(dir);
  }
  let checkout = PathBuf::from("web/dist");
  if checkout.join("index.html").exists() {
    return Source::Dir(checkout);
  }
  #[cfg(feature = "embed-web")]
  if embedded::available() {
    return Source::Embedded;
  }
  Source::None
}

pub fn mount<S: Clone + Send + Sync + 'static>(app: Router<S>, source: &Source) -> Router<S> {
  match source {
    Source::Dir(dir) => {
      log::info!("serving editor from {}", dir.display());
      let index = dir.join("index.html");
      app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)))
    }
    #[cfg(feature = "embed-web")]
    Source::Embedded => {
      log::info!("serving built-in editor");
      app.fallback(embedded::serve)
    }
    Source::None => app,
  }
}

/// Opens the editor in the default browser.
pub fn open_browser(url: &str) {
  let result = if cfg!(target_os = "macos") {
    std::process::Command::new("open").arg(url).spawn()
  } else if cfg!(target_os = "windows") {
    std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn()
  } else {
    std::process::Command::new("xdg-open").arg(url).spawn()
  };
  if let Err(e) = result {
    log::info!("open {url} in your browser ({e})");
  }
}

#[cfg(feature = "embed-web")]
mod embedded {
  use axum::http::{header, StatusCode, Uri};
  use axum::response::{IntoResponse, Response};
  use rust_embed::RustEmbed;

  #[derive(RustEmbed)]
  #[folder = "../../web/dist"]
  struct Assets;

  pub fn available() -> bool {
    Assets::get("index.html").is_some()
  }

  pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    // Unknown paths fall back to the app shell (client-side routing).
    let (file, name) = match Assets::get(path) {
      Some(f) => (f, path),
      None => match Assets::get("index.html") {
        Some(f) => (f, "index.html"),
        None => return StatusCode::NOT_FOUND.into_response(),
      },
    };
    let mime = file.metadata.mimetype().to_string();
    let cache = if name.starts_with("assets/") {
      "public, max-age=31536000, immutable"
    } else {
      "no-cache"
    };
    (
      [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, cache.to_string())],
      file.data,
    )
      .into_response()
  }
}
