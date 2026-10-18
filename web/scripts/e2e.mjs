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
await page.addInitScript(() => localStorage.setItem("dt:tour-done", "1"));
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
