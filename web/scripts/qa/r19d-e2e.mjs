// Round 19, package d (Claude/MCP tools and Claude's saves), driven the way Claude Code drives it:
// JSON-RPC over HTTP to the bridge's /mcp with one editor tab open on a new file. Covers A-1 (the
// contrast fix leaves bound and style-linked colours alone and reports them), A-2 (a typography
// variable beats a text style, and the result says so), C-2 (update_nodes componentId swaps an
// instance, one undo step), A-4 (an unbound component property is `unused`), C-5 (`instancesKept`),
// the papercut results and A-3 (a tool call's edits are stored right away: the editor is killed
// 600 ms after the result, twice, and closed through page.close() once).
// Usage (no internet, no real Claude): a bridge with the fake CLI, the editor from vite preview:
//   CLAUDE_BIN=$PWD/web/scripts/fixtures/fake-claude.mjs designotron --port 7135 --static web/dist \
//     --workspace <scratch> --no-open
//   cd web && DESIGNOTRON_PORT=7135 npx vite preview --port 7131
//   cd web && E2E_URL=http://127.0.0.1:7131 E2E_PROFILE=<scratch dir> node scripts/qa/r19d-e2e.mjs
// Screenshots: E2E_OUT. Every non-local request is aborted; import_url is never called.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL_ = process.env.E2E_URL ?? "http://127.0.0.1:7131";
const OUT = process.env.E2E_OUT ?? "/tmp/r19d-shots";
const PROFILE = process.env.E2E_PROFILE ?? "/tmp/r19d-profile";
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
};
const local = (u) => ["localhost", "127.0.0.1"].includes(new URL(u).hostname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcId = 1;
async function rpc(method, params = {}) {
  const r = await fetch(URL_ + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  return r.json();
}
/** {ok, text, obj}: a tool call over MCP. */
async function tool(name, args = {}) {
  const j = await rpc("tools/call", { name, arguments: args });
  const res = j.result;
  const text = res?.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(j.error ?? j);
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    /* an error message */
  }
  return { ok: !!res && !res.isError, text, obj };
}

const errors = [];
/** An editor (a persistent profile, so a killed one can be reopened) on a file; `url` reopens it. */
async function openEditor(url) {
  const ctx = await chromium.launchPersistentContext(PROFILE, { ...launch, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* sandboxed frames have no storage */
    }
  });
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    return local(u) || u.startsWith("data:") || u.startsWith("blob:") ? route.continue() : route.abort();
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url ?? URL_ + "/", { waitUntil: "domcontentloaded" });
  if (!url) await page.getByText("New design file").first().click();
  await page.waitForSelector("#dt-canvas", { timeout: 20000 });
  await page.waitForFunction(() => window.__dt.chat().bridgeStatus === "connected", null, { timeout: 15000 });
  await sleep(800);
  return { ctx, page };
}

let { ctx, page } = await openEditor();
const fileUrl = page.url();
const doc = () => page.evaluate(() => window.__dt.doc());
const dispatch = (cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const nodes = (d) => Object.values(d.nodes);
const named = (d, name) => nodes(d).find((n) => n.name === name);
const undo = async () => {
  await dispatch({ op: "undo" });
  await sleep(250);
};
const ids = (r) => (r.obj?.created ?? []).map((c) => c.id);

try {
  // ---- tools/list carries the new text ----
  const list = await rpc("tools/list");
  const tools = Object.fromEntries(list.result.tools.map((t) => [t.name, t]));
  const d = (n) => tools[n]?.description ?? "";
  check("update_nodes describes the swap and detached styles", /`componentId` swaps it/.test(d("update_nodes")) && /detaches that style/.test(d("update_nodes")));
  check("arrange explains Property 1", /Chip\/Default.*Property 1/.test(d("arrange")));
  check("create_nodes says an image layer is a rectangle", /`type: image` layer is a rectangle with an image fill/.test(d("create_nodes")));
  check("delete_nodes says instancesKept", /instancesKept/.test(d("delete_nodes")) && !/instancesDetached/.test(d("delete_nodes")));
  check("fix_issues and set_component_props describe skipped and unused", /skipped/.test(d("fix_issues")) && /unused/.test(d("set_component_props")));

  // ---- A-1: the contrast fix leaves a bound colour alone ----
  let r = await tool("define_variables", { collection: "Theme", modes: ["Light", "Night"], variables: [{ name: "Danger", values: { Light: "#CCCCCC", Night: "#111111" } }] });
  check("define_variables returns the touched collection and a count of the others", r.ok && r.obj?.collections?.length === 1 && r.obj?.others === 0, r.text.slice(0, 160));
  r = await tool("create_nodes", {
    nodes: [
      { type: "frame", name: "Screen", x: 0, y: 0, width: 360, height: 200, fill: "#FFFFFF", layout: { direction: "vertical", padding: 24 }, children: [{ type: "text", name: "Logout", text: "Log out", fontSize: 14, bind: { fill: "Theme/Danger" } }] },
    ],
  });
  const lint = await tool("lint_design");
  const low = (lint.obj?.issues ?? []).find((i) => i.kind === "lowContrast");
  check("lint reports the bound text without a fix and names the variable", !!low && !low.fix && /bound to Theme\/Danger/.test(low.message), JSON.stringify(low));
  const fx = await tool("fix_issues", { kinds: ["lowContrast"] });
  check("fix_issues skips it and says why", fx.ok && fx.obj?.fixed === 0 && fx.obj?.skipped?.[0]?.kind === "lowContrast" && /bound to Theme\/Danger/.test(fx.obj.skipped[0].reason), fx.text);
  let dd = await doc();
  check("the binding is still there", !!named(dd, "Logout")?.bindings?.fill);
  const screen = named(dd, "Screen").id;
  await tool("update_nodes", { updates: [{ id: screen, variableModes: { Theme: "Night" } }] });
  dd = await doc();
  check("Night mode recolours the bound text", (named(dd, "Logout")?.fills?.[0]?.color ?? "").toUpperCase() === "#111111", JSON.stringify(named(dd, "Logout")?.fills));
  await shot("a1-bound-contrast");

  // ---- A-2: a typography variable and a text style ----
  await tool("define_variables", { collection: "Type", variables: [{ name: "lg", type: "number", value: 20 }] });
  await tool("define_styles", { texts: [{ name: "Heading/H1", fontSize: 32 }] });
  r = await tool("create_nodes", { nodes: [{ type: "text", name: "Title", text: "Hello", x: 500, y: 0, textStyle: "Heading/H1" }] });
  const titleId = ids(r)[0];
  r = await tool("update_nodes", { updates: [{ id: titleId, bind: { fontSize: "lg" } }] });
  check("update warns that the text style was detached", r.ok && /text style 'Heading\/H1' detached \(fontSize changed\); values kept/.test(r.text), r.text);
  dd = await doc();
  check("the style link is gone, the binding stays", !dd.nodes[titleId].textStyle && !!dd.nodes[titleId].bindings?.fontSize);
  r = await tool("create_nodes", { nodes: [{ type: "text", name: "Title2", text: "Hello", x: 500, y: 100, textStyle: "Heading/H1", bind: { fontSize: "lg" } }] });
  dd = await doc();
  check("create with both links no style and warns", r.ok && /textStyle 'Heading\/H1' not linked: bind\.fontSize/.test(r.text) && !named(dd, "Title2")?.textStyle && !!named(dd, "Title2")?.bindings?.fontSize, r.text);

  // ---- C-2: swap an instance through update_nodes ----
  r = await tool("create_nodes", {
    nodes: [
      { type: "component", name: "Red", x: 0, y: 400, width: 60, height: 60, fill: "#EF4444" },
      { type: "component", name: "Blue", x: 100, y: 400, width: 90, height: 90, fill: "#3B82F6" },
    ],
  });
  const [redId, blueId] = ids(r);
  r = await tool("create_instance", { componentId: redId, x: 300, y: 400 });
  const instId = r.obj?.id;
  r = await tool("update_nodes", { updates: [{ id: instId, componentId: blueId }] });
  check("update_nodes swaps and lists it", r.ok && r.obj?.swapped?.[0]?.to === blueId && r.obj.swapped[0].from === redId, r.text);
  await sleep(300);
  dd = await doc();
  check("the instance is now Blue (size and component)", dd.nodes[instId].instance.componentId === blueId && dd.nodes[instId].width === 90, JSON.stringify(dd.nodes[instId].instance));
  const paintedBlue = await page.evaluate((id) => {
    const el = document.querySelector(`#dt-canvas g[data-root="${id}"]`) ?? document.querySelector(`#dt-canvas [data-id="${id}"]`);
    return el ? el.outerHTML.toUpperCase().includes("#3B82F6") : null;
  }, instId);
  check("the canvas paints the swapped instance in the new component's colour", paintedBlue === true, String(paintedBlue));
  await shot("c2-swapped");
  await undo();
  dd = await doc();
  check("one undo restores the instance", dd.nodes[instId].instance.componentId === redId && dd.nodes[instId].width === 60, JSON.stringify(dd.nodes[instId].instance));
  r = await tool("update_nodes", { updates: [{ id: instId, componentId: "n_missing" }] });
  check("a bad componentId is refused", !r.ok && /no component n_missing/.test(r.text), r.text);

  // ---- A-4: an unbound property ----
  r = await tool("create_nodes", { nodes: [{ type: "component", name: "Row", x: 0, y: 700, width: 200, height: 40, children: [{ type: "text", name: "T", text: "Bench press" }] }] });
  const rowId = ids(r)[0];
  const rowInst = (await tool("create_instance", { componentId: rowId, x: 300, y: 700 })).obj.id;
  r = await tool("set_component_props", { ops: [{ op: "add", component: rowId, kind: "text", name: "Title" }] });
  check("add without bind warns", /not bound to any layer yet/.test(r.text), r.text);
  r = await tool("set_component_props", { ops: [{ op: "set", instance: rowInst, prop: "Title", value: "Squat" }] });
  check("an unbound set is reported unused", r.ok && r.obj?.results?.[0]?.unused === true && /no layer of this instance uses 'Title'/.test(r.text), r.text);

  // ---- papercuts ----
  r = await tool("create_nodes", { nodes: [{ type: "rectangle", fill: "Theme/Danger" }] });
  check("a colour that is a variable name says to bind it", !r.ok && /use bind: \{fill: 'Theme\/Danger'\}/.test(r.text), r.text);
  r = await tool("define_styles", { effects: [{ name: "Soft" }] });
  check("the effect style error names the keys", !r.ok && /shadow \{x, y, blur, spread, color\}, blur or backgroundBlur/.test(r.text), r.text);
  r = await tool("set_prototype", { nodeId: instId, destinationId: screen });
  check("set_prototype echoes the interaction", r.ok && r.obj?.interaction?.destinationId === screen && r.obj.interaction.trigger, r.text);

  // ---- C-5: deleting a main ----
  r = await tool("delete_nodes", { ids: [rowId] });
  check("delete_nodes reports instancesKept with a note", r.ok && r.obj?.instancesKept === 1 && /Restore main component/.test(r.obj.note ?? ""), r.text);

  // ---- A-3: Claude's edits reach storage at once ----
  let n = 0;
  for (const gap of [600, 600]) {
    n++;
    const name = `Saved ${n}`;
    r = await tool("create_nodes", { nodes: [{ type: "rectangle", name, x: 0, y: 1000 + n * 80, width: 50, height: 50 }] });
    await sleep(gap);
    await ctx.close(); // the renderer goes without pagehide, like a crash
    ({ ctx, page } = await openEditor(fileUrl));
    dd = await doc();
    check(`${name}: still there after the editor was killed ${gap} ms after the result`, r.ok && !!named(dd, name));
  }
  // The first reopened tab must be the connected one for tool calls.
  r = await tool("create_nodes", { nodes: [{ type: "rectangle", name: "Saved 3", x: 0, y: 1300, width: 50, height: 50 }] });
  await sleep(150);
  await ctx.close();
  ({ ctx, page } = await openEditor(fileUrl));
  dd = await doc();
  check("Saved 3: still there after the editor was killed 150 ms after the result", r.ok && !!named(dd, "Saved 3"));
  r = await tool("create_nodes", { nodes: [{ type: "rectangle", name: "Saved 4", x: 0, y: 1400, width: 50, height: 50 }] });
  const extra = await ctx.newPage(); // so closing one page leaves the browser (and its storage) alive
  await page.close(); // pagehide fires
  await extra.goto(fileUrl, { waitUntil: "domcontentloaded" });
  await extra.waitForSelector("#dt-canvas", { timeout: 20000 });
  await sleep(800);
  const kept = await extra.evaluate(() => Object.values(window.__dt.doc().nodes).some((x) => x.name === "Saved 4"));
  check("page.close() then reopen: the layer is there", r.ok && kept);
  check("the file kept every earlier edit too", await extra.evaluate(() => ["Saved 1", "Saved 2", "Screen", "Title"].every((nm) => Object.values(window.__dt.doc().nodes).some((x) => x.name === nm))));
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
  failed++;
  console.log("FAIL  script error  - " + (err?.stack ?? err));
} finally {
  await ctx.close().catch(() => {});
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
