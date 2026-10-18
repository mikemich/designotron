// Builds a single self-contained HTML file of the editor (JS, CSS and the WASM
// engine inlined), for hosts that only accept one page, such as Claude artifacts.
// Usage: node scripts/build-single.mjs [out.html]

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "dist-single/designotron.html";
execSync("npx vite build", { stdio: "inherit", env: { ...process.env, DT_SINGLE: "1" } });

const dist = "dist-single";
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const jsFile = html.match(/src="\.\/(assets\/[^"]+\.js)"/)[1];
const cssFile = html.match(/href="\.\/(assets\/[^"]+\.css)"/)?.[1];
const js = fs.readFileSync(path.join(dist, jsFile), "utf8").replace(/<\/script/gi, "<\\/script")
  // Some hosts reject a literal U+FFFD; the escape is equivalent inside JS strings and regexes.
  .replace(/\uFFFD/g, "\\uFFFD");
const css = cssFile ? fs.readFileSync(path.join(dist, cssFile), "utf8") : "";
const wasm = fs.readFileSync("src/wasm/pkg/designotron_engine_wasm_bg.wasm").toString("base64");
const fonts = html.match(/href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)"/)[1];

const page = `<title>Designotron</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>${css}</style>
<div id="root"></div>
<script>window.__DT_WASM_B64 = "${wasm}";</script>
<script type="module">${js}</script>
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`wrote ${out} (${(page.length / 1e6).toFixed(2)} MB)`);
