#!/usr/bin/env node
// `npx designotron`: downloads the release binary for this platform (once, cached)
// and runs it. The binary bundles the editor and the Claude Code bridge.

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = "mikemich/designotron";
const VERSION = require("../package.json").version;

const TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

async function main() {
  const target = TARGETS[`${process.platform}-${process.arch}`];
  if (!target) {
    console.error(`designotron: no prebuilt binary for ${process.platform}-${process.arch}. Build from source: https://github.com/${REPO}`);
    process.exit(1);
  }
  const exe = process.platform === "win32" ? "designotron.exe" : "designotron";
  const dir = path.join(os.homedir(), ".cache", "designotron", VERSION);
  const bin = path.join(dir, exe);
  if (!fs.existsSync(bin)) await download(target, dir);
  const child = spawn(bin, process.argv.slice(2), { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
}

async function download(target, dir) {
  const archive = target.includes("windows") ? "zip" : "tar.gz";
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/designotron-${target}.${archive}`;
  console.error(`designotron: downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `download.${archive}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  if (archive === "zip") {
    execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${file}' -DestinationPath '${dir}'`]);
  } else {
    execFileSync("tar", ["xzf", file, "-C", dir]);
  }
  fs.unlinkSync(file);
  if (process.platform !== "win32") fs.chmodSync(path.join(dir, "designotron"), 0o755);
}

main().catch((err) => {
  console.error(`designotron: ${err.message}`);
  process.exit(1);
});
