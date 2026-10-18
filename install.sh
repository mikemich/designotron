#!/bin/sh
# Installs the latest Designotron release binary.
#   curl -fsSL https://raw.githubusercontent.com/mikemich/designotron/main/install.sh | sh
set -eu

REPO="mikemich/designotron"
DEST="${DESIGNOTRON_INSTALL_DIR:-$HOME/.local/bin}"

os=$(uname -s)
arch=$(uname -m)
case "$os-$arch" in
  Darwin-arm64) target="aarch64-apple-darwin" ;;
  Darwin-x86_64) target="x86_64-apple-darwin" ;;
  Linux-x86_64) target="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64 | Linux-arm64) target="aarch64-unknown-linux-gnu" ;;
  *) echo "Unsupported platform: $os $arch. Build from source: https://github.com/$REPO" >&2; exit 1 ;;
esac

url="https://github.com/$REPO/releases/latest/download/designotron-$target.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $url"
curl -fsSL "$url" -o "$tmp/designotron.tar.gz"
tar xzf "$tmp/designotron.tar.gz" -C "$tmp"
mkdir -p "$DEST"
mv "$tmp/designotron" "$DEST/designotron"
chmod +x "$DEST/designotron"
# Downloaded binaries are quarantined on macOS; the release is unsigned for now.
if [ "$os" = "Darwin" ]; then xattr -d com.apple.quarantine "$DEST/designotron" 2>/dev/null || true; fi

echo "Installed designotron to $DEST/designotron"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "Add it to your PATH:  export PATH=\"$DEST:\$PATH\"" ;;
esac
echo "Run:  designotron"
