// Round 15, package b (Claude tool correctness), driven the way Claude Code drives it: JSON-RPC over
// HTTP to the bridge's /mcp with one editor tab open on a new file. Covers X-01 (union/flatten refuse
// frames with layers inside), X-02 (create_instance checks its parent), X-03/X-14/X-15 (sizes 0-100000,
// min <= max), X-04/X-05 (duplicate names, variable type changes), rename and delete of variables,
// modes, collections and styles, Z-03 (new text takes the first character's style, also through the
// built-in placeholder plugin) and the P3 result fixes. Tool descriptions are checked in tools/list.
// Usage: a bridge serving web/dist with the fake CLI (no internet, no real Claude):
//   CLAUDE_BIN=$PWD/web/scripts/fixtures/fake-claude.mjs designotron --port 6722 --static web/dist \
//     --workspace <scratch> --no-open
//   cd web && E2E_URL=http://127.0.0.1:6722 node scripts/qa/r15b-e2e.mjs
// Screenshots: E2E_OUT. Every non-local request is aborted; import_url is never called.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL_ = process.env.E2E_URL ?? "http://127.0.0.1:6722";
const OUT = process.env.E2E_OUT ?? "/tmp/r15b-shots";
fs.mkdirSync(OUT, { recursive: true });
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

const browser = await chromium.launch(launch);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
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
const errors = [];
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(URL_ + "/", { waitUntil: "domcontentloaded" });
await page.getByText("New design file").first().click();
await page.waitForSelector("#dt-canvas", { timeout: 20000 });
await page.waitForFunction(() => window.__dt.chat().bridgeStatus === "connected", null, { timeout: 15000 });
await sleep(800);

const doc = () => page.evaluate(() => window.__dt.doc());
const dispatch = (cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const nodes = (d) => Object.values(d.nodes);
const named = (d, name) => nodes(d).find((n) => n.name === name);
const pageLayers = async () => {
  const d = await doc();
  const p = d.pages.find((x) => x.id === (d.currentPage ?? d.pages[0].id)) ?? d.pages[0];
  return p.children.map((id) => d.nodes[id]?.name);
};
const undo = async () => {
  await dispatch({ op: "undo" });
  await sleep(250);
};
const idOf = async (name) => named(await doc(), name)?.id;
const fillOf = (n) => (n?.fills?.[0]?.color ?? "").toUpperCase();
const ids = (r) => (r.obj?.created ?? []).map((c) => c.id);

try {
  // ---- tool descriptions say what changed ----
  const list = await rpc("tools/list");
  const tools = Object.fromEntries(list.result.tools.map((t) => [t.name, t]));
  const d = (n) => tools[n]?.description ?? "";
  check("arrange describes the frame refusal", /layers inside is refused/.test(d("arrange")));
  check("define_variables describes rename, delete and types", /rename: \[\{from, to\}\]/.test(d("define_variables")) && /deleteCollection/.test(d("define_variables")) && /keeps its type/.test(d("define_variables")));
  check("define_variables schema has the new fields", ["rename", "delete", "renameModes", "deleteModes", "renameCollection", "deleteCollection"].every((k) => tools.define_variables.inputSchema.properties[k]));
  check("define_variables no longer requires type", !tools.define_variables.inputSchema.properties.variables.items.required.includes("type"));
  check("define_styles describes rename and delete", /rename: \[\{from, to\}\]/.test(d("define_styles")) && tools.define_styles.inputSchema.properties.delete);
  check("update_nodes describes first-character style and sizes", /first character's style/.test(d("update_nodes")) && /100000/.test(d("update_nodes")));
  check("create_instance, get_nodes, delete_nodes, pages, set_prototype, find_nodes descriptions", /can't be placed inside its own component|can't place an instance inside its own component|its own component/.test(d("create_instance")) && /ids. is required/.test(d("get_nodes")) && /instancesDetached/.test(d("delete_nodes")) && /deleted: id/.test(d("pages")) && /cleared: n/.test(JSON.stringify(tools.set_prototype)) && /limit 0/.test(d("find_nodes")));

  // ---- X-01 / X-02: unions and orphans (X's e14/e15) ----
  await tool("create_nodes", {
    nodes: [
      { type: "frame", name: "Home", x: 0, y: 0, width: 390, height: 600, fill: "#FFFFFF", children: [{ type: "text", name: "Heading", text: "Home", fontSize: 24, width: "fill" }] },
      { type: "frame", name: "Modal", x: 500, y: 0, width: 300, height: 200, fill: "#FFFFFF", cornerRadius: 16, children: [{ type: "text", name: "ModalText", text: "Hi", fontSize: 16 }] },
      { type: "component", name: "Button/Primary", x: 0, y: 800, width: 160, height: 48, fill: "#7C5CFF", children: [{ type: "text", name: "Label", text: "Continue", fontSize: 16 }] },
      { type: "rectangle", name: "R1", x: 900, y: 0, width: 100, height: 100 },
      { type: "rectangle", name: "R2", x: 950, y: 20, width: 100, height: 100 },
    ],
  });
  const [home, modal, button, r1, r2] = await Promise.all(["Home", "Modal", "Button/Primary", "R1", "R2"].map(idOf));
  const before = await pageLayers();
  const u = await tool("arrange", { action: "union", ids: [modal, home] });
  check("union of two frames with layers is refused", !u.ok && /(Home|Modal) is a frame with layers inside/.test(u.text) && /Select the shapes inside it, or ungroup it first/.test(u.text), u.text);
  const f = await tool("arrange", { action: "flatten", ids: [home] });
  check("flatten of a frame with layers is refused", !f.ok && /flatten combines shapes/.test(f.text), f.text);
  const after = await pageLayers();
  check("frames and children are intact after the refusals", JSON.stringify(before) === JSON.stringify(after) && !!(await idOf("Heading")) && !!(await idOf("ModalText")), after.join(","));
  await shot("x01-frames-intact");
  // A frame hidden inside a group is refused too, and a layer with min > max stays editable.
  const grp = await tool("arrange", { action: "group", ids: [modal] });
  const grpId = grp.obj?.id ?? (await doc()).nodes[modal].parent;
  const gu = await tool("arrange", { action: "union", ids: [grpId, r1] });
  check("union of a group holding a frame with layers is refused", !gu.ok && /Modal is a frame with layers inside/.test(gu.text) && !!(await idOf("ModalText")), gu.text);
  await undo();
  await dispatch({ op: "update", ids: [r2], patch: { minWidth: 200, maxWidth: 40 } });
  const edit = await tool("update_nodes", { updates: [{ id: r2, fill: "#FF0000", name: "R2" }] });
  check("a layer with min above max can still be edited", edit.ok, edit.text);
  await dispatch({ op: "update", ids: [r2], patch: { minWidth: null, maxWidth: null } });
  const un = await tool("arrange", { action: "union", ids: [r1, r2] });
  check("union of two rectangles still works", un.ok && /Union/.test(JSON.stringify(await pageLayers())), un.text);
  await undo();
  check("one undo restores the rectangles", (await pageLayers()).includes("R1"));
  // The UI refuses the same way (the command itself errors).
  const uiRes = await page.evaluate(([a, b]) => window.__dt.dispatch({ op: "booleanOp", ids: [a, b], operation: "union" }), [home, modal]);
  const uiErr = await page.locator(".toast").first().textContent({ timeout: 2500 }).catch(() => "");
  check("the editor toasts the same refusal", !uiRes && /layers inside/.test(uiErr), String(uiErr));
  await shot("x01-toast");

  const layersBefore = await pageLayers();
  const orphan = await tool("create_instance", { componentId: button, parentId: "n_nope", x: 10, y: 10 });
  check("create_instance with a missing parent errors", !orphan.ok && /no parent layer n_nope/.test(orphan.text), orphan.text);
  const txt = await idOf("Heading");
  const t2 = await tool("create_instance", { componentId: button, parentId: txt });
  check("create_instance inside a text errors", !t2.ok && /cannot have children/.test(t2.text), t2.text);
  const self = await tool("create_instance", { componentId: button, parentId: button });
  check("an instance inside its own component says so", !self.ok && /can't place an instance of Button\/Primary inside Button\/Primary/.test(self.text), self.text);
  check("Layers unchanged after the refusals", JSON.stringify(await pageLayers()) === JSON.stringify(layersBefore));
  const goodInst = await tool("create_instance", { componentId: button, parentId: modal, x: 10, y: 10 });
  const instNode = (await doc()).nodes[goodInst.obj?.id];
  check("a valid parent gets the instance", goodInst.ok && instNode?.parent === modal);

  // ---- sizes ----
  const neg = await tool("create_nodes", { nodes: [{ type: "frame", name: "Neg", width: -120, height: 50 }] });
  check("negative width refused naming the field", !neg.ok && /nodes\[0\]\.width/.test(neg.text) && /0 or more/.test(neg.text), neg.text);
  const big = await tool("create_nodes", { nodes: [{ type: "frame", name: "Big", width: 1e9, height: -5 }] });
  check("1e9 and a negative height are both reported", !big.ok && /width must be at most 100000/.test(big.text) && /height must be 0 or more/.test(big.text), big.text);
  const mm = await tool("create_nodes", { nodes: [{ type: "frame", name: "MM", width: "hug", minWidth: 200, maxWidth: 40 }] });
  check("min larger than max refused", !mm.ok && /minWidth 200 is larger than maxWidth 40/.test(mm.text), mm.text);
  check("nothing was created by the refused sizes", !named(await doc(), "Neg") && !named(await doc(), "Big") && !named(await doc(), "MM"));
  const zero = await tool("create_nodes", { nodes: [{ type: "frame", name: "Zero", width: 0, height: 100000 }] });
  check("0 and 100000 are accepted", zero.ok);
  const upd = await tool("update_nodes", { updates: [{ id: r1, width: 20 }, { id: r2, width: -40 }] });
  check("update with a negative width is refused atomically", !upd.ok && /updates\[1\]\.width/.test(upd.text) && named(await doc(), "R1").width === 100, upd.text);
  const hugeLayout = await tool("update_nodes", { updates: [{ id: r1, maxWidth: 40 }] });
  const minOver = await tool("update_nodes", { updates: [{ id: r1, minWidth: 100 }] });
  check("min is judged against the stored max", hugeLayout.ok && !minOver.ok && /minWidth 100 is larger than maxWidth 40/.test(minOver.text), minOver.text);
  await tool("update_nodes", { updates: [{ id: r1, maxWidth: 0 }] });
  check("0 clears a max", named(await doc(), "R1").maxWidth == null);

  // ---- X-04 / X-05 duplicates and types ----
  const dup = await tool("define_variables", { collection: "Dd", variables: [{ name: "Dup", type: "color", value: "#000000" }, { name: "Dup", type: "number", value: 3 }] });
  check("duplicate variable names in one call are refused", !dup.ok && /variables\[1\]: Dup is already in this call \(variables\[0\]\)/.test(dup.text), dup.text);
  check("the refused call defined nothing", !(await doc()).variables.some((c) => c.name === "Dd"));
  await tool("define_variables", { collection: "Num", variables: [{ name: "Gap", type: "number", value: 4 }] });
  await tool("define_variables", { collection: "Num", variables: [{ name: "Gap", value: 8 }] });
  const gap = (await doc()).variables.find((c) => c.name === "Num").variables[0];
  check("an omitted type keeps the number type", gap.type === "number" && Object.values(gap.values)[0] === 8, JSON.stringify(gap));
  const retype = await tool("define_variables", { collection: "Num", variables: [{ name: "Gap", type: "color", value: "#fff" }] });
  check("a type change is refused with the fix", !retype.ok && /Gap is a number variable/.test(retype.text) && /delete/.test(retype.text), retype.text);
  const sd = await tool("define_styles", { colors: [{ name: "Brand/Primary", color: "#7C5CFF" }, { name: "Brand/Primary", color: "#000000" }] });
  check("duplicate style names in one list are refused", !sd.ok && /colors\[1\]: Brand\/Primary is already in this call \(colors\[0\]\)/.test(sd.text), sd.text);
  const s1 = await tool("define_styles", { colors: [{ name: "Brand/Primary", color: "#7C5CFF" }] });
  const s2 = await tool("define_styles", { colors: [{ name: "Brand/Primary", color: "#00AA00" }] });
  check("the same style name across calls updates in place", s1.ok && s2.ok && s2.obj?.updated?.[0] === s1.obj?.created?.[0], s2.text);

  // ---- rename and delete of variables with a bound layer ----
  await tool("define_variables", {
    collection: "Theme",
    modes: ["Light", "Dark"],
    variables: [
      { name: "Brand", type: "color", values: { Light: "#7C5CFF", Dark: "#B3A3FF" } },
      { name: "Soft", type: "color", value: { alias: "Theme/Brand" } },
    ],
  });
  const bound = await tool("create_nodes", { nodes: [{ type: "rectangle", name: "Bound", x: 0, y: 1200, width: 120, height: 60, bind: { fill: "Brand" } }] });
  const boundId = ids(bound)[0];
  const varId = (await doc()).variables.find((c) => c.name === "Theme").variables.find((v) => v.name === "Brand").id;
  const rn = await tool("define_variables", { collection: "Theme", rename: [{ from: "Brand", to: "Accent" }], renameModes: [{ from: "Dark", to: "Night" }] });
  const dTheme = (await doc()).variables.find((c) => c.name === "Theme");
  check("rename keeps the id, the binding and the colour", rn.ok && rn.obj.unbound === 0 && dTheme.variables.some((v) => v.id === varId && v.name === "Accent") && dTheme.modes.some((m) => m.name === "Night") && (await doc()).nodes[boundId].bindings.fill === varId && fillOf((await doc()).nodes[boundId]) === "#7C5CFF", rn.text.slice(0, 200));
  await page.locator("button[title='Main menu']").click();
  await page.getByRole("menuitem", { name: "Variables…" }).click();
  await page.waitForSelector(".variables-dialog");
  await page.locator(".variables-dialog").getByText("Theme", { exact: true }).first().click();
  await sleep(400);
  const inputs = await page.$$eval(".variables-dialog tr[data-variable] td:first-child input", (els) => els.map((e) => e.value));
  const heads = await page.$$eval(".variables-dialog thead input, .variables-dialog thead th", (els) => els.map((e) => e.value ?? e.textContent).join(" "));
  check("the Variables dialog shows the new variable and mode names", inputs.some((v) => /Accent/.test(v)) && !inputs.some((v) => v === "Brand") && /Night/.test(heads), `${inputs.join("|")} / ${heads.replace(/\s+/g, " ")}`);
  await shot("variables-renamed");
  await page.keyboard.press("Escape");
  await sleep(250);
  await undo();
  const afterUndoRename = (await doc()).variables.find((c) => c.name === "Theme");
  check("one undo restores the old names", afterUndoRename.variables.some((v) => v.name === "Brand") && afterUndoRename.modes.some((m) => m.name === "Dark"));
  const del = await tool("define_variables", { collection: "Theme", delete: ["Brand"] });
  const boundAfter = (await doc()).nodes[boundId];
  check("delete unbinds the layer, keeps its colour and says what it affected", del.ok && del.obj.unbound === 1 && /1 layer/.test(del.obj.note) && /2 aliases|1 alias/.test(del.obj.note) && !boundAfter.bindings?.fill && fillOf(boundAfter) === "#7C5CFF", del.text.slice(0, 260));
  await undo();
  check("one undo restores the variable and its binding", (await doc()).nodes[boundId].bindings?.fill === varId);
  const dm = await tool("define_variables", { collection: "Theme", deleteModes: ["Dark"] });
  check("deleteModes removes the mode", dm.ok && (await doc()).variables.find((c) => c.name === "Theme").modes.length === 1);
  const lastMode = await tool("define_variables", { collection: "Theme", deleteModes: ["Light"] });
  check("the last mode can't be deleted", !lastMode.ok && /only mode/.test(lastMode.text), lastMode.text);
  const dc = await tool("define_variables", { collection: "Theme", deleteCollection: true });
  check("deleteCollection removes it and unbinds", dc.ok && dc.obj.unbound === 1 && !(await doc()).variables.some((c) => c.name === "Theme") && fillOf((await doc()).nodes[boundId]) === "#7C5CFF", dc.text.slice(0, 200));
  await undo();
  check("one undo restores the collection", (await doc()).variables.some((c) => c.name === "Theme"));
  const miss = await tool("define_variables", { collection: "Nope", delete: ["x"] });
  check("a missing collection is named", !miss.ok && /no collection 'Nope'/.test(miss.text) && /Theme/.test(miss.text), miss.text);

  // ---- styles: rename and delete ----
  await tool("define_styles", { texts: [{ name: "Brand/Primary", fontSize: 20 }] });
  const sw = await tool("create_nodes", { nodes: [{ type: "rectangle", name: "Swatch", x: 0, y: 1400, width: 50, height: 50, fillStyle: "Brand/Primary" }] });
  const swId = ids(sw)[0];
  const amb = await tool("define_styles", { rename: [{ from: "Brand/Primary", to: "Main" }] });
  check("a name shared by two kinds is refused with ids", !amb.ok && /names several styles/.test(amb.text) && /color style/.test(amb.text) && /text style/.test(amb.text), amb.text);
  const colorStyle = (await doc()).styles?.colors?.find((c) => c.name === "Brand/Primary") ?? (await doc()).colorStyles?.find((c) => c.name === "Brand/Primary");
  const rs = await tool("define_styles", { rename: [{ from: colorStyle.id, to: "Main" }] });
  check("rename by id keeps the layer link", rs.ok && (await doc()).nodes[swId].fillStyle === colorStyle.id, rs.text);
  const ds = await tool("define_styles", { delete: ["Main"] });
  check("delete unlinks and counts the layers, keeping the colour", ds.ok && ds.obj.unlinked === 1 && !(await doc()).nodes[swId].fillStyle && fillOf((await doc()).nodes[swId]) === "#00AA00", ds.text);
  await undo();
  check("one undo restores the style link", (await doc()).nodes[swId].fillStyle === colorStyle.id);
  const nos = await tool("define_styles", { delete: ["Nothing"] });
  check("a missing style is named", !nos.ok && /no style named 'Nothing'/.test(nos.text), nos.text);

  // ---- Z-03: new text takes the first character's style ----
  const mixed = await tool("create_nodes", {
    nodes: [{ type: "text", name: "Mixed", x: 0, y: 1600, fontSize: 20, spans: [{ text: "Plain, " }, { text: "bold", fontWeight: 800 }, { text: " and " }, { text: "blue", color: "#0000FF" }, { text: " end" }] }],
  });
  const mixedId = ids(mixed)[0];
  check("the mixed text has two runs", (await doc()).nodes[mixedId].text.runs.length === 2);
  await dispatch({ op: "select", ids: [mixedId] });
  await page.locator("button[title='Main menu']").click();
  await page.getByRole("menuitem", { name: "Fill text with placeholder copy" }).click();
  await sleep(1500);
  const filled = (await doc()).nodes[mixedId].text;
  check("the placeholder plugin leaves no mid-word runs", filled.characters !== "Plain, bold and blue end" && (filled.runs ?? []).length === 0, `${filled.characters} / ${JSON.stringify(filled.runs)}`);
  await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), mixedId);
  await sleep(300);
  await shot("z03-placeholder");
  const boldFirst = await tool("create_nodes", { nodes: [{ type: "text", name: "BoldFirst", x: 400, y: 1600, spans: [{ text: "Head", fontWeight: 700 }, { text: " tail" }] }] });
  const bf = ids(boldFirst)[0];
  await tool("update_nodes", { updates: [{ id: bf, text: "A brand new headline" }] });
  const bfRuns = (await doc()).nodes[bf].text.runs;
  check("a bold first run covers the whole new text", bfRuns.length === 1 && bfRuns[0].start === 0 && bfRuns[0].end === 20 && bfRuns[0].fontWeight === 700, JSON.stringify(bfRuns));
  const same = await tool("create_nodes", { nodes: [{ type: "text", name: "Same", x: 800, y: 1600, spans: [{ text: "keep " }, { text: "me", fontWeight: 700 }] }] });
  const sameId = ids(same)[0];
  await tool("update_nodes", { updates: [{ id: sameId, text: "keep me", fontSize: 18 }] });
  check("unchanged characters keep their runs", (await doc()).nodes[sameId].text.runs.length === 1);

  // ---- P3 result fixes ----
  const svgUp = await tool("update_nodes", { updates: [{ id: r2, svg: "<svg/>" }] });
  check("X-07 svg on update_nodes warns", svgUp.ok && /svg is only read by create_nodes/.test(svgUp.text), svgUp.text);
  const gn = await tool("get_nodes", {});
  check("X-08 get_nodes without ids errors", !gn.ok && /ids is required/.test(gn.text), gn.text);
  const sv = await tool("create_nodes", { nodes: [{ type: "svg" }] });
  check("X-10 type svg without svg says so", !sv.ok && /type svg needs an svg string/.test(sv.text), sv.text);
  const ut = await tool("create_nodes", { nodes: [{ type: "widget" }] });
  check("X-10 the unknown-type message lists svg", !ut.ok && /svg/.test(ut.text), ut.text);
  const [screenA, screenB] = [home, modal];
  await tool("set_prototype", { nodeId: screenA, destinationId: screenB });
  const clr = await tool("set_prototype", { nodeId: screenA, clear: true });
  check("X-12 set_prototype clear alone clears", clr.ok && clr.obj.cleared === 1 && !((await doc()).nodes[screenA].interactions ?? []).length, clr.text);
  const sp = await tool("create_nodes", { nodes: [{ type: "text", name: "Typos", x: 0, y: 1800, spans: [{ text: "a", colour: "#f00", fontWeigth: "bold" }] }] });
  check("X-13 span key typos warn with a suggestion", sp.ok && /colour.*did you mean color/.test(sp.text) && /fontWeigth.*did you mean fontWeight/.test(sp.text), sp.text);
  const fl = await tool("find_nodes", { limit: 0 });
  check("X-17 find_nodes limit 0 returns no nodes", fl.ok && fl.obj.nodes.length === 0 && fl.obj.total > 5, fl.text);
  await tool("define_variables", { collection: "Surf", variables: [{ name: "Bg", type: "color", value: "#101010" }] });
  const bf2 = await tool("update_nodes", { updates: [{ id: r2, fill: "#00FF00", bind: { fill: "Bg" } }] });
  check("X-19 fill with bind.fill warns", bf2.ok && /fill ignored: bind\.fill sets it/.test(bf2.text), bf2.text);
  const mainWithInst = await tool("delete_nodes", { ids: [button] });
  check("X-21 deleting a main component reports instances", mainWithInst.ok && mainWithInst.obj.instancesDetached >= 1, mainWithInst.text);
  await undo();
  const longText = await tool("create_nodes", { nodes: [{ type: "text", name: "Long", x: 0, y: 2000, text: "x".repeat(3600) }] });
  const gl = await tool("get_nodes", { ids: ids(longText) });
  check("X-22 truncated text is flagged on the text object", gl.ok && gl.obj[0].text.charactersTruncated === true && gl.obj[0].text.charactersLength === 3600, gl.text.slice(0, 120));
  const pa = await tool("pages", { action: "add", name: "Extra" });
  const pd = await tool("pages", { action: "delete", id: pa.obj?.id });
  check("X-23 pages delete returns the id", pd.ok && pd.obj.deleted === pa.obj?.id, pd.text);

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  failed++;
  console.log("FAIL  script error - " + (e?.stack ?? e));
  await shot("error").catch(() => {});
}
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
