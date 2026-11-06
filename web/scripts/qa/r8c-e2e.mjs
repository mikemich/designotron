// Round 8, editor parity: Shift on a layer, axis-locked moves, picking a selection's parent, Esc and
// backslash, the empty-page prompt, platform shortcut labels, Ctrl+S, Ctrl+Shift+], F2 rename,
// instances that hug and follow their main, the device System UI theme and Shift+A on an empty frame.
// Usage: E2E_URL=http://localhost:5173 [E2E_OUT=dir] node scripts/qa/r8c-e2e.mjs (dev server running)

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const OUT = process.env.E2E_OUT ?? "test-results";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2, acceptDownloads: true });
const page = await context.newPage();
await page.route("**/*", (r) => (/^(http:\/\/(localhost|127\.0\.0\.1)|data:|blob:|ws:)/.test(r.request().url()) ? r.continue() : r.abort()));
await page.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
page.on("pageerror", (e) => check("no page errors", false, String(e)));

const dt = (fn, arg) => page.evaluate(fn, arg);
const run = (cmd) => dt((c) => window.__dt.dispatch(c), cmd);
const sel = () => dt(() => window.__dt.state().selection);
const node = (id) => dt((i) => window.__dt.doc().nodes[i], id);
const page_ = () => dt(() => window.__dt.state().page);
const shot = (n) => page.screenshot({ path: `${OUT}/r8c-${n}.png` });
async function newFile() {
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.waitForTimeout(300);
}
/** Screen point of a page point at the current viewport. */
async function at(x, y) {
  const r = await page.locator("#dt-canvas").boundingBox();
  const v = await dt(() => window.__dt.viewport());
  return { x: r.x + v.x + x * v.zoom, y: r.y + v.y + y * v.zoom };
}
async function setView() {
  await dt(() => window.__dt.setViewport({ zoom: 1, x: 100, y: 100 }));
  await page.waitForTimeout(100);
}
async function mk(kind, x, y, w, h, parent = null, name) {
  const r = await run({ op: "createShape", kind, x, y, width: w, height: h, parent });
  if (name) await run({ op: "update", ids: [r.id], patch: { name } });
  return r.id;
}
async function drag(from, to, { shift = false, steps = 6 } = {}) {
  const a = await at(from.x, from.y);
  const b = await at(to.x, to.y);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
}
async function click(p, { shift = false } = {}) {
  const a = await at(p.x, p.y);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.click(a.x, a.y);
  if (shift) await page.keyboard.up("Shift");
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

try {
  // ---------------------------------------------------------------- Shift on a layer, axis lock
  await newFile();
  await setView();
  const frame = await mk("frame", 0, 0, 500, 400, null, "Screen");
  const r1 = await mk("rectangle", 20, 20, 80, 80, frame, "R1");
  const r2 = await mk("rectangle", 160, 20, 80, 80, frame, "R2");
  const r3 = await mk("rectangle", 300, 20, 80, 80, frame, "R3");
  await run({ op: "select", ids: [] });

  await click({ x: 60, y: 60 });
  check("click selects R1", same(await sel(), [r1]));
  await drag({ x: 200, y: 60 }, { x: 200, y: 160 }, { shift: true });
  const s1 = await sel();
  const [n1, n2] = [await node(r1), await node(r2)];
  check("Shift-press on an unselected layer adds it and the drag moves the whole selection", same(s1, [r1, r2]) && n1.y === 120 && n2.y === 120, `sel=${s1.length} y=${n1.y},${n2.y}`);

  await click({ x: 200, y: 160 }, { shift: true });
  check("Shift-click on a selected layer removes it on release", same(await sel(), [r1]));
  await click({ x: 200, y: 160 }, { shift: true });
  check("Shift-click on an unselected layer adds it", same(await sel(), [r1, r2]));
  const before = await node(r2);
  await drag({ x: 200, y: 160 }, { x: 230, y: 160 }, { shift: true });
  const after = await node(r2);
  check("Shift-drag on a selected layer keeps the selection and moves it", same(await sel(), [r1, r2]) && after.x === before.x + 30, `x ${before.x} -> ${after.x}`);

  // Axis lock: the smaller delta is zeroed.
  await run({ op: "select", ids: [r3] });
  const y0 = (await node(r3)).y;
  const x0 = (await node(r3)).x;
  await drag({ x: 340, y: 60 }, { x: 410, y: 75 }, { shift: true });
  const m3 = await node(r3);
  check("Shift-drag locks to the dominant axis (x)", m3.y === y0 && m3.x > x0 + 50, `x ${x0} -> ${m3.x}, y ${y0} -> ${m3.y}`);
  await drag({ x: 410, y: 60 }, { x: 420, y: 160 }, { shift: true });
  const m3b = await node(r3);
  check("and the other way (y)", m3b.x === m3.x && m3b.y > m3.y + 50, `y ${m3.y} -> ${m3b.y}`);
  await run({ op: "select", ids: [] });
  await shot("shift");

  // ---------------------------------------------------------------- picking the selection's parent
  await newFile();
  await setView();
  const screen = await mk("frame", 0, 0, 500, 500, null, "Screen");
  const card = await mk("frame", 40, 40, 300, 300, screen, "Card");
  const inner = await mk("frame", 20, 20, 200, 200, card, "Inner");
  const leaf = await mk("rectangle", 10, 10, 40, 40, inner, "Leaf");
  await run({ op: "select", ids: [leaf] });
  await click({ x: 40 + 20 + 150, y: 40 + 20 + 150 });
  check("clicking the bare area of the selection's parent selects that parent", same(await sel(), [inner]), JSON.stringify(await sel()));
  await run({ op: "select", ids: [inner] });
  await click({ x: 40 + 280, y: 40 + 280 });
  check("and again one level up", same(await sel(), [card]), JSON.stringify(await sel()));

  // ---------------------------------------------------------------- Esc clears, backslash selects the parent
  await run({ op: "select", ids: [leaf] });
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("\\");
  check("\\ selects the parent", same(await sel(), [inner]));
  await page.keyboard.press("\\");
  check("\\ again goes up", same(await sel(), [card]));
  await page.keyboard.press("Shift+Enter");
  check("Shift+Enter still selects the parent", same(await sel(), [screen]));
  await page.keyboard.press("Escape");
  check("Esc clears the selection", (await sel()).length === 0);

  // Esc after typing in a text layer leaves the layer selected, and one more Esc clears it.
  const t = (await run({ op: "createText", x: 60, y: 400, characters: "Hello", parent: screen })).id;
  await dt((i) => window.__dt.edit(i), t);
  await page.waitForSelector(".text-editor textarea, textarea.text-editor, #dt-canvas textarea");
  await page.keyboard.type(" world");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const afterText = await sel();
  check("one Esc after text editing leaves the text layer selected", same(afterText, [t]) && (await node(t)).text.characters.includes("world"), JSON.stringify(afterText));
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("Escape");
  check("the next Esc clears it", (await sel()).length === 0);

  // ---------------------------------------------------------------- F2 renames from the canvas
  await run({ op: "select", ids: [card] });
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("F2");
  await page.waitForSelector("input[aria-label='Layer name']", { timeout: 3000 });
  await page.keyboard.type("Hero card");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  check("F2 renames the selected layer in the Layers tree", (await node(card)).name === "Hero card");
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("Control+r").catch(() => {});
  // (Ctrl+R is left to the browser: no rename input appears for it.)
  check("Ctrl+R does not start a rename", !(await page.$("input[aria-label='Layer name']")));

  // ---------------------------------------------------------------- Ctrl+Shift+] / [
  await newFile();
  await setView();
  const a = await mk("rectangle", 0, 0, 60, 60, null, "A");
  const b = await mk("rectangle", 100, 0, 60, 60, null, "B");
  const c = await mk("rectangle", 200, 0, 60, 60, null, "C");
  const order = () => dt(() => window.__dt.doc().pages.find((p) => p.id === window.__dt.state().page).children);
  await run({ op: "select", ids: [a] });
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("Control+Shift+BracketRight");
  check("Ctrl+Shift+] brings to front", (await order()).at(-1) === a, JSON.stringify(await order()));
  await page.keyboard.press("Control+Shift+BracketLeft");
  check("Ctrl+Shift+[ sends to back", (await order())[0] === a);
  await page.keyboard.press("Control+BracketRight");
  check("Ctrl+] still brings forward one step", (await order()).indexOf(a) === 1);
  // On DE/ES/IT layouts the "]" key types "+": Ctrl+"+" must zoom, not reorder.
  await run({ op: "select", ids: [c] });
  const orderBefore = JSON.stringify(await order());
  const z0 = (await dt(() => window.__dt.viewport())).zoom;
  await page.evaluate(() => {
    const ev = new KeyboardEvent("keydown", { key: "+", code: "BracketRight", ctrlKey: true, bubbles: true, cancelable: true });
    document.getElementById("dt-canvas").dispatchEvent(ev);
  });
  const z1 = (await dt(() => window.__dt.viewport())).zoom;
  check('Ctrl with key "+" on the BracketRight position zooms and does not reorder', z1 > z0 && JSON.stringify(await order()) === orderBefore, `zoom ${z0} -> ${z1}`);
  await dt(() => window.__dt.setViewport({ zoom: 1, x: 100, y: 100 }));
  await page.click("#dt-canvas", { button: "right", position: { x: 300, y: 300 } }).catch(() => {});
  await run({ op: "select", ids: [b] });
  const bp = await at(130, 30);
  await page.mouse.click(bp.x, bp.y, { button: "right" });
  await page.waitForSelector(".menu .item");
  const labels = await page.$$eval(".menu .item", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  await shot("context-menu");
  check("context menu labels use Ctrl+Shift+] and Ctrl+Alt+K off a Mac", labels.some((l) => l.includes("Bring to front") && l.includes("Ctrl+Shift+]")) && labels.some((l) => l.includes("Create component") && l.includes("Ctrl+Alt+K")), labels.filter((l) => /front|component|properties/i.test(l)).join(" | "));
  await page.keyboard.press("Escape");

  // ---------------------------------------------------------------- Ctrl+S saves locally, Ctrl+Shift+S downloads
  await run({ op: "update", ids: [a], patch: { name: "Saved A" } });
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => /Saved locally/.test(document.body.innerText), null, { timeout: 4000 }).catch(() => {});
  const toastText = await page.evaluate(() => document.body.innerText.includes("Saved locally"));
  await page.waitForTimeout(500);
  check("Ctrl+S toasts 'Saved locally' and makes no download", toastText && downloads === 0, `downloads=${downloads}`);
  check("and the autosave has flushed (not dirty)", !(await dt(() => window.__dt.dirty())));
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }), page.keyboard.press("Control+Shift+s")]);
  check("Ctrl+Shift+S downloads the .dtron", dl.suggestedFilename().endsWith(".dtron"), dl.suggestedFilename());

  // ---------------------------------------------------------------- Shift+A on an empty frame
  const empty = await mk("frame", 400, 300, 320, 200, null, "Empty");
  await run({ op: "select", ids: [empty] });
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("Shift+A");
  const ef = await node(empty);
  check("Shift+A on an empty frame keeps its size", !!ef.layout && ef.width === 320 && ef.height === 200, `${ef.width}x${ef.height}`);

  // ---------------------------------------------------------------- Device System UI keeps content visible
  const phone = await mk("frame", 900, 0, 390, 844, null, "Phone");
  await run({ op: "setDevice", id: phone, device: { preset: "iphone-17", theme: "light", statusBar: true, homeIndicator: true, chrome: true, nav: "gesture", url: "example.com", pad: true }, resize: true });
  const label = (await run({ op: "createText", x: 24, y: 120, characters: "Your cart", parent: phone })).id;
  await run({ op: "select", ids: [phone] });
  await page.waitForSelector("[aria-label='System UI']");
  await page.locator("[role=group][aria-label='System UI'] button:has-text('Dark')").click();
  await page.waitForTimeout(200);
  const ph = await node(phone);
  const lt = await node(label);
  check("Dark System UI keeps the screen fill so 'Your cart' stays readable", ph.device.theme === "dark" && ph.fills[0]?.color?.toUpperCase() === "#FFFFFF" && lt.text.runs.length >= 0 && lt.fills[0]?.color?.toUpperCase() !== "#FFFFFF", `${ph.fills[0]?.color} text ${lt.fills[0]?.color}`);
  await shot("device");
  const empty2 = await mk("frame", 1400, 0, 390, 844, null, "Empty phone");
  await run({ op: "setDevice", id: empty2, device: { preset: "iphone-17", theme: "light", statusBar: true, homeIndicator: true, chrome: true, nav: "gesture", url: "example.com", pad: true }, resize: true });
  await run({ op: "setDevice", id: empty2, device: { preset: "iphone-17", theme: "dark", statusBar: true, homeIndicator: true, chrome: true, nav: "gesture", url: "example.com", pad: true }, resize: false });
  check("an empty screen still flips to black in Dark", (await node(empty2)).fills[0]?.color?.toUpperCase() === "#000000");

  // ---------------------------------------------------------------- instances hug and follow in the same edit
  const txt = (await run({ op: "createText", x: 0, y: 700, characters: "Hi", parent: null })).id;
  const hugFrame = (await run({ op: "addAutoLayout", ids: [txt] })).id;
  const main = (await run({ op: "createComponent", ids: [hugFrame] })).id;
  const inst = (await run({ op: "createInstance", componentId: main, x: 0, y: 900, parent: null })).id;
  const ni = await node(inst);
  check("an instance of a hugging main hugs", ni.sizingH === "hug" && ni.sizingV === "hug", `${ni.sizingH}/${ni.sizingV}`);
  await run({ op: "setText", id: txt, characters: "A much longer label than before" });
  const [wm, wi] = [(await node(main)).width, (await node(inst)).width];
  check("editing the main's text resizes the instance in the same edit", wi === wm && wm > 100, `main ${wm} instance ${wi}`);

  // ---------------------------------------------------------------- the empty-page prompt
  await newFile();
  check("a new file shows the empty-page prompt with a close button", !!(await page.$(".empty-prompt .empty-close")));
  await shot("empty-prompt");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("Esc closes the prompt", !(await page.$(".empty-prompt")));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  // Another page still shows it; coming back to the first stays closed.
  const first = await page_();
  const p2 = (await run({ op: "addPage", name: "Page 2" }))?.id;
  if (p2) await run({ op: "setPage", id: p2 });
  await page.waitForTimeout(200);
  check("a second empty page has its own prompt", !!(await page.$(".empty-prompt")));
  await run({ op: "setPage", id: first });
  await page.waitForTimeout(200);
  check("the first page stays closed", !(await page.$(".empty-prompt")));
  await page.click(".empty-close").catch(() => {});
  await run({ op: "setPage", id: p2 });
  await page.waitForTimeout(150);
  await page.click(".empty-close");
  check("the close button closes it too", !(await page.$(".empty-prompt")));
  await newFile();
  await page.click("#empty-prompt-input");
  await page.keyboard.press("Escape");
  check("Esc in the prompt's text box closes it", !(await page.$(".empty-prompt")));
  await newFile();
  await mk("rectangle", 10, 10, 50, 50);
  await page.waitForTimeout(150);
  check("drawing something still hides it", !(await page.$(".empty-prompt")));

  // ---------------------------------------------------------------- shortcuts dialog
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("?");
  await page.waitForSelector("[role=dialog]");
  const text = await page.locator("[role=dialog]").innerText();
  check("shortcuts list Esc (clear), backslash (parent), Ctrl+Shift+S, F2 and front/back", /Clear the selection\s*Esc/.test(text) && /Select parent\s*\\/.test(text) && /Ctrl\+Shift\+S/.test(text) && /Rename the selected layer\s*F2/.test(text) && /Ctrl\+Shift\+\]/.test(text), "");
  await shot("shortcuts");
  await page.keyboard.press("Escape");
} catch (e) {
  check("script ran to the end", false, String(e?.stack ?? e));
}
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
