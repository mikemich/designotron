// Tool surface: wrong input gives errors or warnings, styles apply by name, find_nodes, compact answers.
// Drives the MCP endpoint of a bridge with a live editor tab (so the WASM engine runs the tools).
// Usage: bridge on E2E_MCP's port + vite on E2E_URL's port, then `node scripts/qa/w7b-e2e.mjs`.
// Env: E2E_URL (default http://localhost:5173), E2E_MCP (default http://127.0.0.1:5174/mcp), CHROMIUM.

import { chromium } from "playwright-core";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const MCP = process.env.E2E_MCP ?? "http://127.0.0.1:5174/mcp";
const SPECS = path.resolve(path.dirname(new globalThis.URL(import.meta.url).pathname), "../fixtures/w7b-specs");

const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" };

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 300) : ""}`);
}

let rpcId = 1;
/** Calls a tool; `payload` is the parsed JSON (or the text of an error), `bytes` the size of the answer. */
async function call(name, args = {}) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await r.json();
  const text = j.result?.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(j.error ?? j);
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    /* an error message */
  }
  return { isError: !!j.result?.isError || !!j.error, payload, text, bytes: text.length };
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.route(
  (u) => !/^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) && !/^(data|blob):/.test(u.toString()),
  (r) => r.abort(),
);
const page = await context.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const doc = () => page.evaluate(() => window.__dt.doc());
const node = async (id) => (await doc()).nodes[id];
const byName = async (name) => Object.values((await doc()).nodes).find((n) => n.name === name);
const fresh = async () => {
  await page.goto(URL);
  await page.waitForSelector(".files");
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.waitForFunction(() => window.__dt.chat().bridgeStatus === "connected", null, { timeout: 15000 });
};

try {
  await fresh();

  // --- Dangling parents and unknown ids (H-B1, H-B17) ---
  const c = await call("create_nodes", {
    nodes: [
      {
        type: "frame", name: "Screen", width: 360, height: 300, fill: "#FFFFFF", layout: { direction: "vertical", gap: 12, padding: 24 },
        children: [
          { type: "rectangle", name: "Keep", width: 100, height: 60, fill: "#4F46E5" },
          { type: "rectangle", name: "Victim", width: 100, height: 60, fill: "#F43F5E" },
          { type: "text", name: "Caption", text: "Hello" },
        ],
      },
    ],
  });
  const screen = c.payload.created[0].id;
  const victim = c.payload.names.Victim;
  const caption = c.payload.names.Caption;
  check("create_nodes returns top-level layers and a names map, no outlines", !c.isError && c.payload.created.length === 1 && c.payload.created[0].children === undefined && !!victim, c.text);
  let m = await call("move_nodes", { ids: [victim], parentId: "n_does_not_exist" });
  check("move to a missing parent is an error", m.isError && m.text.includes("n_does_not_exist"), m.text);
  let n = await node(victim);
  check("the layer stays under its old parent", n.parent === screen && (await node(screen)).children.includes(victim));
  m = await call("move_nodes", { ids: [victim], parentId: caption });
  check("moving into a text layer is an error", m.isError && m.text.includes("cannot have children"), m.text);
  let d = await call("delete_nodes", { ids: ["n_ghost", victim] });
  check("delete reports unknown ids", !d.isError && d.payload.notFound?.[0] === "n_ghost" && d.payload.deleted?.[0] === victim, d.text);
  d = await call("delete_nodes", { ids: ["n_ghost"] });
  check("delete with only unknown ids is an error", d.isError, d.text);
  m = await call("move_nodes", { ids: [await (async () => (await byName("Keep")).id)()], x: 500, y: 500 });
  check("x/y on an auto layout child is a warning, not a move", !m.isError && m.payload.moved.length === 0 && /auto layout/.test(m.payload.warnings?.[0] ?? ""), m.text);

  // --- Agent mistakes (t_mistakes / t_mistakes2) ---
  let r = await call("create_nodes", { nodes: [{ type: "frame", name: "Pct", width: "50%", height: 40 }] });
  check('width "50%" is an error naming the field', r.isError && r.text.startsWith("nodes[0].width:"), r.text);
  r = await call("create_nodes", { nodes: [{ type: "text", name: "Sz", text: "Hi", fontSize: "24px", fontWeight: "bold", x: 1000 }] });
  n = await byName("Sz");
  check('fontSize "24px" and fontWeight "bold" are read', !r.isError && n?.text.fontSize === 24 && n?.text.fontWeight === 700, r.text);
  r = await call("create_nodes", { nodes: [{ type: "rectangle", name: "Rad", width: 40, height: 40, x: 1000, y: 100, cornerRadius: { tl: 8 }, shadow: "0 4px 12px rgba(0,0,0,0.1)" }] });
  n = await byName("Rad");
  check("cornerRadius object and CSS shadow string are read", !r.isError && JSON.stringify(n.cornerRadii) === "[8,0,0,0]" && n.effects?.length === 1, r.text);
  r = await call("create_nodes", { nodes: [{ type: "frame", name: "Pad", width: 100, height: 100, x: 1000, y: 200, layout: { direction: "HORIZONTAL", padding: { vertical: 8, horizontal: 16 } } }] });
  n = await byName("Pad");
  check("direction HORIZONTAL and padding object are read", !r.isError && n.layout.direction === "horizontal" && n.layout.paddingTop === 8 && n.layout.paddingLeft === 16, r.text);
  r = await call("create_nodes", { nodes: [{ type: "frame", x: 1000, y: 300, layout: { direction: "horizontal", crossAlign: "stretch" } }] });
  check("crossAlign stretch is an error that says to use fill", r.isError && /fill/.test(r.text) && r.text.includes("layout.crossAlign"), r.text);
  r = await call("create_nodes", { nodes: [{ type: "frame", name: "Fig", x: 1000, y: 400, width: 100, height: 100, layoutMode: "VERTICAL", itemSpacing: 8 }] });
  check("Figma names warn and name the real key", !r.isError && r.payload.warnings?.some((w) => w.includes("itemSpacing") && w.includes("layout.gap")), r.text);
  r = await call("create_nodes", { nodes: [{ type: "frame", name: "Gap", x: 1000, y: 500, width: 100, height: 100, gap: 8, padding: 16, children: [{ type: "rectangle", width: 5, height: 5 }] }] });
  n = await byName("Gap");
  check("top-level gap/padding on a frame is mapped, with a warning", !r.isError && n.layout?.gap === 8 && n.layout?.paddingLeft === 16 && r.payload.warnings?.length >= 1, r.text);
  r = await call("create_nodes", { nodes: ["a rectangle"] });
  check("a string in nodes is an error", r.isError, r.text);
  r = await call("create_nodes", { nodes: [{ type: "rectangle", imageUrl: "javascript:alert(1)" }] });
  check("imageUrl javascript: is an error", r.isError && r.text.includes("imageUrl"), r.text);
  r = await call("create_nodes", { nodes: [{ type: "text", spans: [{ text: "a", color: "blue-ish" }] }] });
  check("an unreadable span colour is an error", r.isError && r.text.includes("spans[0].color"), r.text);
  r = await call("export_code", { id: screen, format: "vue" });
  check("export_code vue is an error", r.isError && r.text.includes("vue"), r.text);

  // --- Components, prototypes, variables (t_comp) ---
  const base = await call("create_nodes", {
    nodes: [
      { type: "frame", name: "Home", x: 0, y: 1200, width: 300, height: 300, children: [{ type: "frame", name: "Btn", width: 80, height: 30, fill: "#4F46E5", children: [{ type: "text", name: "Label", text: "Go" }] }] },
      { type: "frame", name: "Other", x: 400, y: 1200, width: 300, height: 300 },
    ],
  });
  const btn = base.payload.names.Btn;
  const other = base.payload.created[1].id;
  const home = base.payload.created[0].id;
  r = await call("set_prototype", { nodeId: btn, action: "navigte", destinationId: other });
  check("set_prototype typo in the action is an error listing the values", r.isError && r.text.includes("navigate"), r.text);
  r = await call("set_prototype", { nodeId: btn, action: "navigate" });
  check("navigate without a destination is an error", r.isError, r.text);
  r = await call("set_prototype", { nodeId: btn, destinationId: btn });
  check("a destination that isn't a top-level frame is an error", r.isError, r.text);
  await call("set_prototype", { nodeId: btn, destinationId: other });
  await call("set_prototype", { nodeId: btn, destinationId: home });
  check("the same trigger twice leaves one interaction", (await node(btn)).interactions.length === 1);
  r = await call("set_prototype", { nodeId: btn, trigger: "delay", delay: 2500, destinationId: other });
  check("delay is settable", !r.isError && (await node(btn)).interactions.find((i) => i.trigger === "afterDelay")?.delayMs === 2500, r.text);

  r = await call("define_variables", {
    collection: "Theme", modes: ["Light", "Dark"],
    variables: [{ name: "Surface", type: "color", values: { Light: "#FFFFFF", Dark: "#111111" } }, { name: "Radius", type: "number", value: 8 }],
  });
  r = await call("create_nodes", { nodes: [{ type: "rectangle", x: 2000, bind: { fill: "Surface/Nope" } }] });
  check("binding to a missing variable is an error", r.isError && r.text.includes("bind.fill"), r.text);
  r = await call("create_nodes", { nodes: [{ type: "rectangle", x: 2000, bind: { cornerRadius: "Surface" } }] });
  check("binding a colour variable to a number property is an error", r.isError, r.text);
  r = await call("create_nodes", { nodes: [{ type: "frame", x: 2000, variableModes: { Theme: "Sepia" } }] });
  check("a mode that doesn't exist is an error listing the modes", r.isError && r.text.includes("Light"), r.text);
  r = await call("create_nodes", { nodes: [{ type: "frame", name: "Dark frame", x: 2000, y: 100, width: 50, height: 50, bind: { fill: "Theme/Surface" }, variableModes: { Theme: "Dark" } }] });
  check("a valid binding and mode still work", !r.isError, r.text);

  // --- Styles by name, find_nodes ---
  r = await call("define_styles", { colors: [{ name: "Brand", color: "not-a-colour" }] });
  check("define_styles with an invalid colour is an error", r.isError && r.text.includes("colors[0].color"), r.text);
  await call("define_styles", { colors: [{ name: "Brand", color: "#7C5CFF" }], texts: [{ name: "Heading", fontSize: 28, fontWeight: "bold", lineHeight: 36 }] });
  r = await call("define_styles", { colors: [{ name: "Brand", color: "#FF0000" }] });
  check("a duplicate style name updates the style", !r.isError && r.payload.updated?.length === 1 && (await doc()).styles.colors.length === 1, r.text);
  d = await call("get_document", { depth: 1 });
  check("get_document lists text styles", d.payload.textStyles?.[0]?.name === "Heading" && d.payload.textStyles[0].font === "Inter 700 28/36", JSON.stringify(d.payload.textStyles));
  r = await call("create_nodes", { nodes: [{ type: "frame", name: "Styled", x: 3000, width: 200, layout: { direction: "vertical" }, fillStyle: "Brand", children: [{ type: "text", name: "Title", text: "Hello", textStyle: "Heading" }] }] });
  const styled = await byName("Styled");
  const title = await byName("Title");
  check("fillStyle and textStyle link and apply", !r.isError && !!styled.fillStyle && styled.fills[0].color === "#FF0000" && title.text.fontSize === 28 && !!title.textStyle, r.text);
  r = await call("create_nodes", { nodes: [{ type: "text", text: "x", x: 3000, y: 300, textStyle: "Headng" }] });
  check("an unknown style name is an error listing the styles", r.isError && r.text.includes("Heading"), r.text);
  let f = await call("find_nodes", { name: "styl" });
  check("find_nodes by name", f.payload.total === 1 && f.payload.nodes[0].name === "Styled", f.text);
  f = await call("find_nodes", { type: "text", text: "hello" });
  check("find_nodes by type and text", f.payload.nodes.some((x) => x.name === "Title"), f.text);
  f = await call("find_nodes", { name: "/^(btn|styled)$/" });
  check("find_nodes by /regex/", f.payload.total === 2, f.text);
  f = await call("find_nodes", { style: "Heading" });
  check("find_nodes by linked style", f.payload.total === 1 && f.payload.nodes[0].name === "Title", f.text);

  // --- Compact answers ---
  const rows = Array.from({ length: 250 }, (_, i) => ({
    type: "frame", name: `Row ${i}`, width: "fill", height: 40, layout: { direction: "horizontal" },
    children: [{ type: "text", name: `Label ${i}`, text: "x" }, { type: "rectangle", name: `Dot ${i}`, width: 8, height: 8 }, { type: "rectangle", name: `Bar ${i}`, width: 8, height: 8 }],
  }));
  r = await call("create_nodes", { nodes: [{ type: "frame", name: "Table", x: 4000, width: 400, layout: { direction: "vertical" }, children: rows }] });
  check("a 1000-layer create answers in under 20 KB", !r.isError && r.bytes < 20000, `${r.bytes} bytes`);
  d = await call("get_document", {});
  check("get_document on a big page stays under 40 KB and says it was cut", d.bytes < 40000 && typeof d.payload.truncated === "string", `${d.bytes} bytes`);
  const bigText = await call("create_nodes", { nodes: [{ type: "text", name: "Huge", x: 6000, width: 300, text: "word ".repeat(30000) }] });
  const g = await call("get_nodes", { ids: [bigText.payload.created[0].id] });
  check("get_nodes cuts huge text", g.payload[0].textTruncated === true && g.bytes < 20000, `${g.bytes} bytes`);

  // --- The hand-written UIs still build without errors ---
  await fresh();
  for (const name of ["card-grid", "nav-bar", "form", "pricing", "mobile"]) {
    const { nodes } = await import(pathToFileURL(path.join(SPECS, `${name}.mjs`)).href);
    const res = await call("create_nodes", { nodes });
    check(`${name} spec builds`, !res.isError, res.isError ? res.text : `${res.bytes} bytes${res.payload.warnings ? ", warnings: " + JSON.stringify(res.payload.warnings) : ""}`);
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("unexpected exception", false, e.stack ?? e);
} finally {
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
