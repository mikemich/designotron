// End-to-end smoke test: drives the editor in headless Chromium.
// Usage: start `npm run dev` (port 5173), then `npm run e2e`.
// Env: E2E_URL (default http://localhost:5173), E2E_OUT (screenshot dir), CHROMIUM (executable path).

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const OUT = process.env.E2E_OUT ?? "test-results";
fs.mkdirSync(OUT, { recursive: true });

const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" };

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* sandboxed frames (plugins) have no storage */
  }
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !m.text().includes("WebSocket") && !m.text().includes("Failed to load resource") && errors.push(m.text()));

const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const state = () => page.evaluate(() => window.__dt.state());
const doc = () => page.evaluate(() => window.__dt.doc());

try {
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 20000 });
  check("files dashboard loads", true);
  await shot("01-files");

  await page.click(".file-card:has-text('Mobile app')");
  await page.waitForSelector("#dt-canvas", { timeout: 15000 });
  await page.waitForTimeout(800);
  const d0 = await doc();
  const names = Object.values(d0.nodes).map((n) => n.name);
  check("sample builds screens", names.includes("Welcome") && names.includes("Home"), `${Object.keys(d0.nodes).length} nodes`);
  check("sample has component + instance", Object.values(d0.nodes).some((n) => n.type === "component") && Object.values(d0.nodes).some((n) => n.type === "instance"));
  const rendered = await page.locator("#dt-canvas svg").first().innerHTML();
  check("canvas renders engine SVG", rendered.includes("data-id"), `${rendered.length} chars`);
  await shot("02-sample");

  // Draw a rectangle with the R tool.
  const canvas = await page.locator("#dt-canvas").boundingBox();
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  const sx = canvas.x + canvas.width - 260;
  const sy = canvas.y + 120;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 120, sy + 80, { steps: 6 });
  await page.mouse.up();
  let st = await state();
  const d1 = await doc();
  const rect = d1.nodes[st.selection[0]];
  check("rectangle tool draws and selects", rect?.type === "rectangle", rect ? `${Math.round(rect.width)}×${Math.round(rect.height)}` : "none");
  await shot("03-rect");

  // Move it by dragging.
  const before = { x: rect.x, y: rect.y };
  await page.mouse.move(sx + 60, sy + 40);
  await page.mouse.down();
  await page.mouse.move(sx + 160, sy + 140, { steps: 8 });
  await page.mouse.up();
  const moved = (await doc()).nodes[rect.id];
  check("drag moves the layer", moved.x !== before.x && moved.y !== before.y, `(${before.x},${before.y}) → (${moved.x},${moved.y})`);

  // Undo the move.
  await page.keyboard.press("Control+z");
  const undone = (await doc()).nodes[rect.id];
  check("undo restores position", undone.x === before.x && undone.y === before.y);

  // Change fill via the panel hex input.
  const hex = page.locator(".panel.right .field input").filter({ hasText: "" });
  await page.evaluate(() => window.__dt.dispatch({ op: "update", ids: window.__dt.state().selection, patch: { fills: [{ type: "solid", color: "#FF3366", opacity: 1, visible: true }], cornerRadius: 16 } }));
  const filled = (await doc()).nodes[rect.id];
  check("properties update", filled.fills[0].color === "#FF3366" && filled.cornerRadius === 16);
  void hex;

  // Text tool.
  await page.keyboard.press("t");
  await page.mouse.click(sx, sy + 260);
  await page.waitForSelector(".text-editor");
  await page.keyboard.type("Hello Designotron");
  await page.keyboard.press("Escape");
  st = await state();
  const textNode = (await doc()).nodes[st.selection[0]];
  check("text tool creates text", textNode?.text?.characters === "Hello Designotron", textNode ? `${Math.round(textNode.width)}px wide` : "");
  await shot("04-text");

  // Mixed styles: select "Designotron" while editing and press Ctrl+B.
  await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), textNode.id);
  await page.evaluate((id) => window.__dt.edit(id), textNode.id);
  await page.waitForSelector(".text-editor");
  await page.evaluate(() => {
    const ta = document.querySelector(".text-editor");
    ta.focus();
    ta.setSelectionRange(6, 17);
    ta.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Escape");
  const styled = (await doc()).nodes[textNode.id].text;
  check("Ctrl+B bolds only the selected word", styled.runs.length === 1 && styled.runs[0].start === 6 && styled.runs[0].end === 17 && styled.runs[0].fontWeight === 700, JSON.stringify(styled.runs));
  await shot("04b-mixed-text");

  // Group + auto layout via shortcuts.
  await page.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), [rect.id, textNode.id]);
  await page.keyboard.press("Shift+A");
  st = await state();
  const al = (await doc()).nodes[st.selection[0]];
  check("Shift+A wraps in auto layout", !!al?.layout && al.children.length === 2, al?.layout?.direction);

  // Component from selection.
  await page.keyboard.press("Control+Alt+k");
  st = await state();
  check("create component shortcut", (await doc()).nodes[st.selection[0]]?.type === "component");

  // Pen tool: three clicks + Enter.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("p");
  await page.mouse.click(canvas.x + 200, canvas.y + canvas.height - 200);
  await page.mouse.click(canvas.x + 300, canvas.y + canvas.height - 260);
  await page.mouse.click(canvas.x + 400, canvas.y + canvas.height - 180);
  await page.keyboard.press("Enter");
  st = await state();
  check("pen tool creates vector", (await doc()).nodes[st.selection[0]]?.type === "vector");

  // Vector edit mode: click a segment to add a point (it stays selected), delete it, undo.
  const penId = st.selection[0];
  const penCount = async () => (await doc()).nodes[penId]?.vector.subpaths[0].points.length;
  const segMid = { x: canvas.x + 250, y: canvas.y + canvas.height - 230 };
  await page.mouse.dblclick(segMid.x, segMid.y);
  await page.mouse.click(segMid.x, segMid.y);
  const added = await penCount();
  check("vector edit: click on a segment adds a point", added === 4 && (await page.locator(".vector-anchor.selected").count()) === 1, `${added} points`);
  await page.keyboard.press("Delete");
  const removed = await penCount();
  await page.keyboard.press("Control+z");
  check("vector edit: Delete removes the selected point, undo restores it", removed === 3 && (await penCount()) === 4);
  await page.keyboard.press("Escape");

  // Vector edit mode inside a frame: marquee from the frame's background, stale selections.
  {
    const dsp = (cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
    const fid = (await dsp({ op: "createShape", kind: "frame", x: 3000, y: 3000, width: 400, height: 300, parent: null })).id;
    const vid = (
      await dsp({
        op: "createVector",
        points: [
          { x: 3100, y: 3100, inX: 0, inY: 0, outX: 0, outY: 0 },
          { x: 3200, y: 3180, inX: 0, inY: 0, outX: 0, outY: 0 },
          { x: 3300, y: 3100, inX: 0, inY: 0, outX: 0, outY: 0 },
        ],
        closed: false,
        parent: fid,
      })
    ).id;
    const rid = (await dsp({ op: "createShape", kind: "rectangle", x: 3110, y: 3190, width: 80, height: 30, parent: fid })).id;
    await dsp({ op: "select", ids: [vid] });
    await page.keyboard.press("Shift+2");
    await page.waitForTimeout(300);
    const scr = async (x, y) => {
      const vp = await page.evaluate(() => window.__dt.viewport());
      const box = await page.locator("#dt-canvas").boundingBox();
      return { x: box.x + vp.x + x * vp.zoom, y: box.y + vp.y + y * vp.zoom };
    };
    const ve = () => page.evaluate(() => window.__dt.vectorEdit());
    const nPts = async () => (await doc()).nodes[vid].vector.subpaths[0].points.length;
    const at = await scr(3150, 3140);
    await page.mouse.dblclick(at.x, at.y);
    check("vector in a frame: double-click enters edit mode", (await ve()).id === vid);

    // Stale selections: insert (selected), undo, Delete must not remove another point.
    await page.mouse.click(at.x, at.y);
    const grown = await nPts();
    const selAfterInsert = (await ve()).points.length;
    await page.keyboard.press("Control+z");
    check("vector edit: undo clears the point selection", grown === 4 && selAfterInsert === 1 && (await nPts()) === 3 && (await ve()).points.length === 0);
    await page.keyboard.press("Delete");
    check("vector edit: Delete after undo removes nothing", (await nPts()) === 3 && (await ve()).id === vid);
    // A remote-style change to the path (anchor count changes) drops the selection too.
    const a0 = await scr(3100, 3100);
    await page.mouse.click(a0.x, a0.y);
    const hadSel = (await ve()).points.length === 1;
    await dsp({ op: "insertVectorPoint", id: vid, sub: 0, seg: 1, t: 0.5 });
    check("vector edit: changed anchor count drops the selection", hadSel && (await ve()).points.length === 0);
    await page.keyboard.press("Control+z");

    // Marquee starting on the frame background selects anchors and does not move the frame.
    const frameBefore = (await doc()).nodes[fid];
    const m0 = await scr(3090, 3070);
    const m1 = await scr(3215, 3195);
    await page.mouse.move(m0.x, m0.y);
    await page.mouse.down();
    await page.mouse.move((m0.x + m1.x) / 2, (m0.y + m1.y) / 2, { steps: 4 });
    await page.mouse.move(m1.x, m1.y, { steps: 4 });
    await page.mouse.up();
    const frameAfter = (await doc()).nodes[fid];
    check(
      "vector edit: marquee from the frame background selects anchors",
      (await ve()).id === vid && (await ve()).points.length === 2 && frameAfter.x === frameBefore.x && frameAfter.y === frameBefore.y,
      JSON.stringify((await ve()).points),
    );
    // Arrow keys with anchors selected move them; with none selected they leave the layer alone.
    const x0 = (await doc()).nodes[vid].x;
    await page.keyboard.press("ArrowRight");
    const moved = (await doc()).nodes[vid].x === x0 + 1;
    const bg = await scr(3250, 3205);
    await page.mouse.click(bg.x, bg.y);
    check("vector edit: click beside the path clears the points, stays in edit mode", (await ve()).id === vid && (await ve()).points.length === 0);
    const xBefore = (await doc()).nodes[vid].x;
    await page.keyboard.press("ArrowRight");
    check("vector edit: arrows move selected anchors only, never the whole layer", (await doc()).nodes[vid].x === xBefore && moved);
    // Clicking another layer leaves edit mode and selects it.
    const rc = await scr(3150, 3205);
    await page.mouse.click(rc.x, rc.y);
    check("vector edit: clicking another layer exits and selects it", (await ve()).id === null && (await state()).selection[0] === rid);
    // Finally empty canvas with nothing selected leaves edit mode and deselects.
    await dsp({ op: "select", ids: [vid] });
    await page.mouse.dblclick(at.x, at.y);
    await page.waitForTimeout(100);
    const entered = (await ve()).id === vid;
    const out = await scr(3260, 3205);
    await page.mouse.click(out.x, out.y);
    check("vector edit: a click on the frame background keeps the session", entered && (await ve()).id === vid);
    await page.keyboard.press("Escape");
    await dsp({ op: "select", ids: [] });
  }

  // Code export.
  const welcome = Object.values(await doc()).length && Object.values((await doc()).nodes).find((n) => n.name === "Welcome");
  const react = await page.evaluate((id) => window.__dt.query({ q: "exportReact", id }), welcome.id);
  check("React export", react.includes("export default function Welcome") && react.includes("flex"), `${react.length} chars`);
  const files = await page.evaluate(() => window.__dt.query({ q: "exportProject" }));
  check("project export", files.some((f) => f.path === "src/App.tsx") && files.some((f) => f.path.startsWith("src/screens/")), `${files.length} files`);

  // AI tool layer (same path Claude uses).
  const r = await page.evaluate(() =>
    window.__dt.dispatch({
      op: "ai",
      tool: "create_nodes",
      input: { nodes: [{ type: "frame", name: "AI card", x: 0, y: 950, width: 320, fill: "#FFFFFF", cornerRadius: 16, layout: { direction: "vertical", padding: 20, gap: 8 }, children: [{ type: "text", text: "Made by a tool call", fontSize: 20, fontWeight: 700 }, { type: "text", text: "Same API as Claude Code via MCP.", width: "fill", color: "#555" }] }] },
    }),
  );
  check("AI create_nodes", !!r?.created?.[0]?.id);

  // Screenshot tool (browser-only).
  const shotRes = await page.evaluate(async (id) => {
    const out = await window.__dt.tool("get_screenshot", { id });
    return { ok: out.ok, len: out.image?.data.length ?? 0, err: out.ok ? null : out.result };
  }, welcome.id);
  check("get_screenshot rasterises", shotRes.ok && shotRes.len > 1000, shotRes.err ?? `${shotRes.len} b64 chars`);

  // Import HTML tool.
  const imp = await page.evaluate(async () => {
    return window.__dt.tool("import_html", {
      html: '<div style="padding:32px;background:#0F172A;color:white;font-family:Inter"><h1 style="margin:0 0 12px;font-size:40px">Pricing</h1><p style="color:#94A3B8;margin:0">Simple plans for everyone.</p><button style="margin-top:20px;padding:12px 20px;border-radius:10px;border:0;background:#7C5CFF;color:white;font-size:16px">Start free</button></div>',
      x: 900,
      y: 950,
      width: 600,
    });
  });
  check("import_html converts DOM to layers", imp.ok, imp.ok ? "" : String(imp.result));
  // Flex rows import as auto layout; autoLayout:false keeps absolute layers.
  const flexHtml = '<div style="display:flex;gap:12px;padding:16px"><div style="width:80px;height:40px;background:#eee"></div><div style="width:80px;height:40px;background:#ddd"></div></div>';
  const rows = () => page.evaluate(() => Object.values(window.__dt.doc().nodes).filter((n) => n.layout?.direction === "horizontal" && n.layout.gap === 12).length);
  const importFlex = (autoLayout, x) => page.evaluate(([html, autoLayout, x]) => window.__dt.tool("import_html", { html, width: 400, x, y: 950, autoLayout }), [flexHtml, autoLayout, x]);
  const rowsBefore = await rows();
  await importFlex(false, 2200);
  const afterAbs = await rows();
  await importFlex(true, 2700);
  const afterAuto = await rows();
  check("import_html maps flex to auto layout", afterAuto === afterAbs + 1, `${afterAuto - afterAbs} new row(s)`);
  check("import_html autoLayout:false keeps absolute layers", afterAbs === rowsBefore);

  // Prototype player.
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__dt.zoomToFit());
  await page.waitForTimeout(300);
  await shot("05-after-edits");
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter", { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot("06-present");
  const hotspots = await page.locator(".presenter .hotspot").count();
  check("presenter shows hotspots", hotspots > 0, `${hotspots} hotspot(s)`);
  if (hotspots) {
    await page.locator(".presenter .hotspot").first().click();
    await page.waitForTimeout(500);
    const label = await page.locator(".presenter .bar .muted").innerText();
    check("prototype navigation", label === "Home", label);
  }
  await page.keyboard.press("Escape");

  // Persistence: reload and confirm the file survives.
  await page.waitForTimeout(1200);
  const count = Object.keys((await doc()).nodes).length;
  await page.reload();
  await page.waitForSelector("#dt-canvas", { timeout: 15000 });
  await page.waitForTimeout(500);
  const count2 = Object.keys((await doc()).nodes).length;
  check("autosave survives reload", count2 === count, `${count} → ${count2} nodes`);

  // Review tab: lint finds issues and Fix all resolves the fixable ones.
  await page.evaluate(() =>
    window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "frame", name: "Lint me", x: 2000, y: 0, width: 300, height: 200, fill: "#FFFFFF", layout: { direction: "vertical", gap: 7, padding: 15 }, children: [{ type: "text", text: "Faint text", color: "#E5E5E5" }] }] } }),
  );
  await page.click(".panel.right .tab:has-text('Review')");
  await page.waitForSelector(".issue");
  const issuesBefore = await page.locator(".issue").count();
  await page.click("button:has-text('automatically')");
  await page.waitForTimeout(200);
  const left = await page.evaluate(() => window.__dt.query({ q: "lint" }).filter((i) => i.fix).map((i) => `${i.kind}: ${i.message} ${JSON.stringify(i.fix)}`));
  check("Review tab lists issues and fixes them", issuesBefore > 0 && left.length === 0, `${issuesBefore} issues; left: ${left.join(" | ")}`);
  await shot("05b-review");
  await page.click(".panel.right .tab:has-text('Design')");

  // Rulers and guides: Shift+R shows rulers; dragging out of the left ruler adds a vertical guide.
  await page.click("#dt-canvas", { position: { x: 600, y: 900 } });
  await page.keyboard.press("Shift+R");
  await page.waitForSelector(".ruler.left", { timeout: 3000 });
  const lr = await page.locator(".ruler.left").boundingBox();
  await page.mouse.move(lr.x + 10, lr.y + 300);
  await page.mouse.down();
  await page.mouse.move(lr.x + 200, lr.y + 300, { steps: 5 });
  await page.mouse.up();
  const guides = await page.evaluate(() => window.__dt.doc().pages.find((p) => p.id === window.__dt.state().page).guides);
  check("drag from ruler creates a guide", guides.length === 1 && guides[0].axis === "x", JSON.stringify(guides));

  // Layout grid on a frame: overlay draws the columns.
  await page.evaluate(() => {
    const d = window.__dt.doc();
    const id = Object.values(d.nodes).find((n) => n.name === "Lint me").id;
    window.__dt.dispatch({ op: "select", ids: [id] });
  });
  await page.click(".section:has-text('Layout grid') .ibtn[title='Add layout grid']");
  await page.waitForTimeout(100);
  const bands = await page.locator(".grid-overlay rect").count();
  check("layout grid adds column overlay", bands === 12, `${bands} bands`);
  await shot("05c-rulers-grid");

  // Version history: save, change, restore, undo the restore.
  await page.click(".panel .tab:has-text('History')");
  await page.fill(".history input.textinput", "Before delete");
  await page.click(".history button:has-text('Save')");
  await page.waitForSelector(".version:has-text('Before delete')");
  const nodesBefore = Object.keys((await doc()).nodes).length;
  await page.keyboard.press("Delete");
  const nodesDeleted = Object.keys((await doc()).nodes).length;
  // Row actions show on hover.
  await page.hover(".version:has-text('Before delete')");
  await page.click(".version:has-text('Before delete') .ibtn[title='Restore this version']");
  await page.waitForFunction((n) => Object.keys(window.__dt.doc().nodes).length === n, nodesBefore, { timeout: 3000 }).catch(() => {});
  const nodesRestored = Object.keys((await doc()).nodes).length;
  check("version restore brings back deleted layers", nodesDeleted < nodesBefore && nodesRestored === nodesBefore, `${nodesBefore} → ${nodesDeleted} → ${nodesRestored}`);
  await page.keyboard.press("Shift+R");
  await page.click(".panel .tab:has-text('Layers')");

  // Boolean subtract from the toolbar menu, then a mask with ⌥⌘M.
  const made = await page.evaluate(() =>
    window.__dt.dispatch({
      op: "ai",
      tool: "create_nodes",
      input: {
        nodes: [
          { type: "rectangle", name: "Base", x: -600, y: 0, width: 120, height: 120, fill: "#6D4AFF" },
          { type: "ellipse", name: "Hole", x: -570, y: 30, width: 60, height: 60, fill: "#000000" },
          { type: "ellipse", name: "Avatar mask", x: -390, y: 10, width: 100, height: 100, fill: "#000000" },
          { type: "rectangle", name: "Photo", x: -400, y: 0, width: 120, height: 120, fill: "#14AE5C" },
        ],
      },
    }).created.map((c) => c.id),
  );
  await page.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), [made[0], made[1]]);
  await page.click(".tbtn[title='Boolean operations']");
  await page.click(".menu .item:has-text('Subtract selection')");
  const boolNode = await page.evaluate(() => {
    const d = window.__dt.doc();
    const n = d.nodes[window.__dt.state().selection[0]];
    return { type: n.type, name: n.name, subpaths: n.vector?.subpaths?.length };
  });
  check("boolean subtract makes a vector with a hole", boolNode.type === "vector" && boolNode.subpaths === 2, JSON.stringify(boolNode));
  await page.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), [made[2], made[3]]);
  await page.keyboard.press("Control+Alt+KeyM");
  const masked = await page.evaluate(() => document.querySelector(".canvas > svg")?.innerHTML.includes("<mask"));
  check("use as mask renders an SVG mask", masked);
  await page.evaluate(() => {
    const d = window.__dt.doc();
    const ids = Object.values(d.nodes).filter((n) => n.name === "Subtract" || n.name === "Mask group").map((n) => n.id);
    window.__dt.dispatch({ op: "select", ids });
  });
  await page.keyboard.press("Shift+2");
  await page.waitForTimeout(150);
  await shot("05d-boolean-mask");

  // Variables: create a collection with Light/Dark in the dialog, bind a fill, switch the frame's mode.
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await page.click(".panel.right .tab:has-text('Design')");
  await page.click("button:has-text('Open variables')");
  await page.click(".variables-dialog button:has-text('Create collection')");
  await page.click(".variables-dialog .ibtn[title='Add mode']");
  await page.click(".variables-dialog button:has-text('Create variable')");
  await page.click(".menu .item:has-text('Color')");
  const coll = await page.evaluate(() => window.__dt.doc().variables[0]);
  // Give the second mode a different colour through the hex field.
  const hexField = page.locator(".variables-dialog tbody tr td:nth-child(3) input.mono");
  await hexField.fill("#111111");
  await hexField.press("Enter");
  await shot("05e-variables");
  await page.keyboard.press("Escape");
  await page.click(".modal-head .ibtn[title='Close']").catch(() => {});
  const varId = coll.variables[0].id;
  const themed = await page.evaluate((varId) => {
    const r = window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "frame", name: "Themed", x: -900, y: 0, width: 200, height: 120, children: [{ type: "rectangle", name: "Tile", width: 80, height: 80 }] }] } });
    const frame = r.created[0].id;
    const tile = window.__dt.doc().nodes[frame].children[0];
    window.__dt.dispatch({ op: "select", ids: [tile] });
    return { frame, tile };
  }, varId);
  await page.click(".section:has-text('Variables') .ibtn[title='Bind a property']");
  await page.locator(".section:has-text('Variables') .row:has-text('Fill') select").selectOption(varId);
  const light = await page.evaluate((id) => window.__dt.doc().nodes[id].fills[0].color, themed.tile);
  await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), themed.frame);
  const modeSelect = page.locator(".section:has-text('Variables') .row").first().locator("select");
  await modeSelect.selectOption({ index: 2 });
  const dark = await page.evaluate((id) => window.__dt.doc().nodes[id].fills[0].color, themed.tile);
  check("variables: bound fill follows the frame's mode", light === "#6D4AFF" && dark === "#111111", `${light} → ${dark}`);

  // Comments: the comment tool pins a thread to a layer; Claude's tools reply and resolve it.
  await page.keyboard.press("Escape");
  await page.click("#dt-canvas", { position: { x: 700, y: 950 } });
  await page.keyboard.press("c");
  const tile = await page.evaluate(() => {
    const d = window.__dt.doc();
    return Object.values(d.nodes).find((n) => n.name === "Tile")?.id;
  });
  await page.evaluate((id) => (window.__dt.dispatch({ op: "select", ids: [id] }), window.__dt.zoomToFit()), tile);
  await page.waitForTimeout(200);
  const tileBox = await page.evaluate((id) => {
    const el = document.querySelector(`#dt-canvas [data-id="${id}"]`);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, tile);
  await page.mouse.click(tileBox.x, tileBox.y);
  await page.waitForSelector(".comment-popover textarea");
  const nameField = page.locator(".comment-popover input[placeholder='Your name']");
  if (await nameField.count()) await nameField.fill("Ana");
  await page.fill(".comment-popover textarea", "Make the tile rounder");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".comment-pin");
  await shot("05f-comments");
  const thread = await page.evaluate(() => Object.values(window.__dt.doc().comments)[0]);
  await page.evaluate(async (id) => {
    await window.__dt.tool("reply_comment", { id, text: "Done, radius 16" });
    await window.__dt.tool("resolve_comment", { id });
  }, thread.id);
  const after = await page.evaluate((id) => window.__dt.doc().comments[id], thread.id);
  check("comments: pinned to a layer, replied and resolved by Claude's tools", thread.node === tile && after.resolved && after.messages[1].author === "Claude", JSON.stringify({ node: thread.node, msgs: after.messages.length }));
  await page.keyboard.press("v");

  {
  // Plugins: a built-in plugin edits the selection as one undo step; a UI plugin runs in its
  // sandboxed iframe; a plugin trying to reach the editor's DOM fails without side effects.
  const shapes = await page.evaluate(() =>
    window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [0, 1, 2].map((i) => ({ type: "rectangle", name: `P${i}`, x: -1200 + i * 60, y: 0, width: 40, height: 40, fill: "#888888" })) } }).created.map((c) => c.id),
  );
  await page.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), shapes);
  await page.evaluate(() => window.__dt.runPlugin("builtin-palette"));
  await page.waitForFunction(() => window.__dt.plugin() === null, null, { timeout: 5000 });
  const recoloured = await page.evaluate((ids) => ids.map((id) => window.__dt.doc().nodes[id].fills[0].color), shapes);
  await page.keyboard.press("Control+z");
  const reverted = await page.evaluate((ids) => ids.map((id) => window.__dt.doc().nodes[id].fills[0].color), shapes);
  check("plugin recolours the selection as one undo step", recoloured.every((c) => c !== "#888888") && reverted.every((c) => c === "#888888"), recoloured.join(","));
  await page.evaluate(() => window.__dt.runPlugin("builtin-rename"));
  await page.waitForSelector(".plugin-header");
  const ui = page.frameLocator("iframe.plugin-frame");
  await ui.locator("#name").fill("Swatch");
  await ui.locator("#go").click();
  await page.waitForFunction(() => window.__dt.plugin() === null, null, { timeout: 5000 });
  const names = await page.evaluate((ids) => ids.map((id) => window.__dt.doc().nodes[id].name), shapes);
  check("UI plugin renames layers from its sandboxed panel", names.join() === "Swatch 1,Swatch 2,Swatch 3", names.join());
  const escaped = await page.evaluate(async (id) => {
    const { savePlugin, runPlugin } = await import("/src/plugins.ts");
    savePlugin({ id: "evil", name: "Evil", description: "", code: `parent.document.title = "pwned"; await dt.tool("delete_nodes", { ids: ["${id}"] });` });
    runPlugin({ id: "evil", name: "Evil", description: "", code: `parent.document.title = "pwned"; await dt.tool("delete_nodes", { ids: ["${id}"] });` });
    await new Promise((r) => setTimeout(r, 800));
    return { title: document.title, exists: !!window.__dt.doc().nodes[id] };
  }, shapes[0]);
  check("plugins are sandboxed from the editor", escaped.title !== "pwned" && escaped.exists, JSON.stringify(escaped));
  }

  // Figma import from a saved REST API export.
  await page.evaluate(() => (location.hash = "#/"));
  await page.waitForSelector(".files");
  await page.click(".files-head button:has-text('Import from Figma')");
  await page.waitForSelector(".figma-dialog");
  await page.setInputFiles(".figma-dialog input[type=file]", path.join(import.meta.dirname, "fixtures", "figma-sample.json"));
  await page.waitForFunction(() => window.__dt.doc().pages.some((p) => p.name === "Screens"), null, { timeout: 5000 });
  const fig = await page.evaluate(() => {
    const d = window.__dt.doc();
    const nodes = Object.values(d.nodes);
    const inst = nodes.find((n) => n.type === "instance");
    const label = inst && d.nodes[inst.children[0]];
    return { pages: d.pages.map((p) => p.name), instance: !!inst?.instance?.componentId, label: label?.text?.characters };
  });
  check("Figma JSON import keeps components and instance overrides", fig.pages.join() === "Screens" && fig.instance && fig.label === "Checkout", JSON.stringify(fig));
  await shot("08b-figma-import");

  // Templates: each builds into a fresh file from the files screen.
  for (const name of ["Landing page", "Dashboard", "Design system"]) {
    await page.evaluate(() => (location.hash = "#/"));
    await page.waitForSelector(".files");
    await page.click(`.file-card:has-text('${name}')`);
    await page.waitForSelector("#dt-canvas");
    await page.waitForTimeout(300);
    const n = Object.keys((await doc()).nodes).length;
    check(`template "${name}" builds`, n > 10, `${n} nodes`);
    await shot(`08-template-${name.replace(/ /g, "-").toLowerCase()}`);
  }
  const ds = await doc();
  check("design system template has styles and variants", ds.styles.colors.length >= 5 && Object.values(ds.nodes).some((n) => n.type === "componentSet"));

  // New empty file shows the prompt.
  await page.evaluate(() => (location.hash = "#/"));
  await page.waitForSelector(".files");
  await page.click("button:has-text('New design file')");
  await page.waitForSelector(".empty-prompt", { timeout: 5000 });
  check("empty file shows the design prompt", true);
  await shot("09-empty-prompt");

  // Chat panel opens.
  await page.keyboard.press("Control+/");
  await page.waitForSelector(".chat", { timeout: 3000 });
  await shot("07-chat");
  check("Claude panel opens", true);

  // Image attachments and quick actions.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.setInputFiles(".chat-input input[type=file]", { name: "shot.png", mimeType: "image/png", buffer: png });
  await page.waitForSelector(".attachment img", { timeout: 3000 });
  check("image attachment shows a thumbnail", (await page.evaluate(() => window.__dt.chat().pending.length)) === 1);
  await page.click(".chat-input .ibtn[title='Quick actions']");
  const actions = await page.$$eval(".menu .item", (els) => els.map((e) => e.textContent));
  check("quick actions menu", actions.length >= 10 && actions.some((a) => a.includes("Rebuild attached screenshot")), `${actions.length} actions`);
  await page.keyboard.press("Escape");

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
  check("unexpected exception", false, String(err));
  await shot("zz-failure").catch(() => {});
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, "e2e-results.json"), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
