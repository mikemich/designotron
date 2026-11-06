// Device frames: grouped preset picker, system UI (status bar, home indicator, window chrome), light and
// dark, safe-area padding, resizing between presets, undo, code export and the presenter.
// Usage: E2E_URL=http://localhost:5611 node scripts/qa/devices-e2e.mjs (dev server running).
// Env: E2E_URL, CHROMIUM (executable path), E2E_OUT (screenshot directory, optional).

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const OUT = process.env.E2E_OUT;
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: OUT ? 2 : 1 });
// Nothing may leave the machine.
await context.route(/^https?:\/\/(?!(127\.0\.0\.1|localhost)[:/])/, (r) => r.abort());
const p = await context.newPage();
await p.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));

const doc = () => p.evaluate(() => window.__dt.doc());
const state = () => p.evaluate(() => window.__dt.state());
const dispatch = (cmd) => p.evaluate((cmd) => window.__dt.dispatch(cmd), cmd);
const sel = async () => (await state()).selection;
const nodes = async () => Object.values((await doc()).nodes);
const named = async (name) => (await nodes()).find((n) => n.name === name);
const allNamed = async (name) => (await nodes()).filter((n) => n.name === name);
const focusCanvas = () => p.evaluate(() => document.getElementById("dt-canvas").focus());
const press = async (k, wait = 200) => {
  await p.keyboard.press(k);
  await sleep(wait);
};
const view = (x = 20, y = 20, zoom = 1) => p.evaluate((v) => window.__dt.setViewport(v), { x, y, zoom });
const shot = async (name) => {
  if (OUT) await p.screenshot({ path: path.join(OUT, name) });
};
const fillOf = (n) => n?.fills?.[0]?.color;
/** The selected frame, fresh from the document. */
const frame = async () => (await doc()).nodes[(await sel())[0]];
const deviceSection = () => p.locator(".section:has(.section-head:has-text('Device'))");
const theme = (label) => p.locator(`[role=group][aria-label='System UI'] button:has-text("${label}")`);
const checkbox = (label) => p.locator(`label:has-text("${label}") input[type=checkbox]`);

try {
  await p.goto(URL);
  await p.click("button:has-text('New design file')");
  await p.waitForSelector("#dt-canvas");
  await sleep(400);
  await view();

  // ---------- 1: the Frame tool's grouped picker ----------
  await focusCanvas();
  await press("f");
  const groups = await p.locator(".frame-presets [role=group]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  check("the picker is grouped (Phone, Tablet, Desktop, Web, Social, Print, Presentation)", ["Phone", "Tablet", "Desktop", "Web", "Social", "Print", "Presentation"].every((g) => groups.includes(g)), groups.join("|"));
  await shot("devices-picker.png");
  const search = p.locator(".preset-picker input[type=search]").first();
  await search.click();
  await p.keyboard.type("pro");
  await sleep(150);
  const shown = await p.locator(".frame-presets [role=option]").allInnerTexts();
  check("typing 'pro' filters the rows", shown.length >= 3 && shown.every((t) => /pro/i.test(t)), shown.map((t) => t.replace(/\s+/g, " ")).join("|"));
  await p.keyboard.press("ArrowDown");
  check("ArrowDown highlights the first row", (await p.locator(".frame-presets [role=option][aria-selected=true]").count()) === 1);
  await shot("devices-picker-filtered.png");
  await p.keyboard.press("Enter");
  await sleep(400);
  let f = await frame();
  check("Enter makes a 402 x 874 frame", f?.type === "frame" && f.width === 402 && f.height === 874, JSON.stringify(f && [f.name, f.width, f.height]));
  check("it is the iPhone 17 Pro and the device is recorded", f?.name === "iPhone 17 Pro" && f.device?.preset === "iphone-17-pro" && f.device?.theme === "light");
  const bar = await named("Status bar");
  const home = await named("Home indicator");
  check("it has a Status bar and a Home indicator, locked and fixed", bar?.devicePart === "statusBar" && home?.devicePart === "homeIndicator" && bar.locked && home.locked && bar.scrollBehavior === "fixed");
  check("they are the frame's last children", f.children.slice(-2).join() === [bar.id, home.id].join());
  check("one undo step covers frame and chrome", await (async () => {
    await focusCanvas();
    await press("Control+z");
    const gone = !(await named("Status bar")) && !(await named("iPhone 17 Pro"));
    await press("Control+Shift+z");
    return gone && !!(await named("Status bar"));
  })());
  await dispatch({ op: "select", ids: [f.id] });
  await sleep(200);
  check("the Device section shows the device and the safe area", (await deviceSection().innerText()).includes("Safe area 62 top · 34 bottom"), await deviceSection().innerText().catch(() => ""));
  await view(120, 40, 0.95);
  await sleep(300);
  await shot("devices-iphone-light.png");

  // ---------- 2: dark ----------
  await theme("Dark").click();
  await sleep(250);
  const time = await named("Time");
  check("Dark turns the glyphs white", fillOf(time) === "#FFFFFF" && fillOf(await named("Home indicator")) === "#FFFFFF", fillOf(time));
  check("Dark is pressed", (await theme("Dark").getAttribute("aria-pressed")) === "true" && (await theme("Light").getAttribute("aria-pressed")) === "false");
  check("the device records the theme", (await frame()).device.theme === "dark");
  check("the frame's plain white fill follows to black (no invisible glyphs)", fillOf(await frame()) === "#000000", fillOf(await frame()));
  await shot("devices-iphone-dark.png");

  // ---------- 3: status bar off and on ----------
  await checkbox("Status bar").uncheck();
  await sleep(250);
  check("Status bar off removes it", !(await named("Status bar")) && !(await named("Dynamic Island")) && !!(await named("Home indicator")));
  check("the safe area shrinks to the bottom", (await deviceSection().innerText()).includes("Safe area 34 bottom"));
  await checkbox("Status bar").check();
  await sleep(250);
  const bar2 = await named("Status bar");
  check("Status bar on brings it back, still dark", !!bar2 && fillOf(await named("Time")) === "#FFFFFF");

  // ---------- 4: auto layout pads to the safe area ----------
  await focusCanvas();
  await press("Shift+a");
  f = await frame();
  check("Shift+A adds auto layout and keeps the device size", !!f.layout && f.width === 402 && f.height === 874 && f.sizingH === "fixed" && f.sizingV === "fixed", JSON.stringify([f.width, f.height, f.sizingH, f.sizingV]));
  check("paddingTop includes the 62 px safe area", f.layout.paddingTop === 72 && f.layout.paddingBottom === 44, `${f.layout.paddingTop} ${f.layout.paddingBottom}`);
  check("the safe area is remembered as applied", f.device.applied.join() === "62,0,34,0", f.device.applied.join());
  check("the chrome left the flow", (await Promise.all([named("Status bar"), named("Home indicator")])).every((n) => n.absolutePosition));
  await shot("devices-padded.png");
  await checkbox("Pad content to safe area").uncheck();
  await sleep(200);
  check("unchecking Pad takes the safe area out of the padding", (await frame()).layout.paddingTop === 10);
  await checkbox("Pad content to safe area").check();
  await sleep(200);
  check("checking it puts it back", (await frame()).layout.paddingTop === 72);
  await dispatch({ op: "createText", x: 20, y: 150, characters: "Welcome", parent: f.id });
  await dispatch({ op: "select", ids: [f.id] });

  // ---------- 5: resize to a browser preset by keyboard ----------
  await p.locator("button:has-text('Resize to preset')").click();
  const popSearch = p.locator("input[type=search][aria-label='Search size presets']");
  await popSearch.waitFor();
  check("the popover search box has focus", await popSearch.evaluate((e) => document.activeElement === e));
  await p.keyboard.type("browser 1440");
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("Enter");
  await sleep(400);
  f = await frame();
  check("Browser 1440 sizes the frame 1440 x 900", f.width === 1440 && f.height === 900, `${f.width}x${f.height}`);
  check("the phone chrome is replaced by the browser toolbar", !(await named("Status bar")) && !(await named("Home indicator")) && (await named("Browser toolbar"))?.devicePart === "browserBar");
  check("theme is kept (dark)", f.device.theme === "dark" && f.device.preset === "browser-1440");
  check("padding moved by the inset difference (10 + 84, bottom 10)", f.layout.paddingTop === 94 && f.layout.paddingBottom === 10, `${f.layout.paddingTop} ${f.layout.paddingBottom}`);
  check("the toolbar spans the new width", (await named("Browser toolbar")).width === 1440);
  const url = p.locator("input[aria-label=Address]");
  check("the URL field shows the default address", (await url.inputValue()) === "example.com");
  await url.fill("designotron.dev/home");
  await url.press("Enter");
  await sleep(300);
  check("editing the URL rewrites the address bar", (await named("URL")).text.characters === "designotron.dev/home");
  await view(20, 20, 0.5);
  await sleep(300);
  await shot("devices-browser.png");

  // ---------- 6: undo and redo ----------
  await focusCanvas();
  await press("Control+z");
  check("undo restores the previous address", (await named("URL")).text.characters === "example.com");
  await press("Control+z");
  f = await frame();
  check("undo again goes back to the phone", f.width === 402 && f.height === 874 && !!(await named("Status bar")) && !(await named("Browser toolbar")) && f.layout.paddingTop === 72, `${f.width}x${f.height}`);
  await press("Control+Shift+z");
  await press("Control+Shift+z");
  f = await frame();
  check("redo twice returns to the browser with the new address", f.width === 1440 && (await named("URL")).text.characters === "designotron.dev/home");
  await press("Control+z");
  await press("Control+z");

  // ---------- 7: code export leaves the chrome out ----------
  await dispatch({ op: "select", ids: [f.id] });
  await p.click("#right-tab-code");
  await sleep(300);
  const code = await p.locator(".code-block").innerText();
  check("the code has the content and no system UI", code.includes("Welcome") && !/Status bar|9:41|Home indicator|Dynamic Island|Battery/.test(code));
  check("the safe area is env() and the padding the content's own", code.includes("env(safe-area-inset-top") && code.includes("env(safe-area-inset-bottom"), code.slice(0, 400));
  const chromeLayer = await named("Status bar");
  await dispatch({ op: "select", ids: [chromeLayer.id] });
  await sleep(250);
  check("the Code tab says a chrome layer is not exported", (await p.locator(".scroll").last().innerText()).includes("Device UI, not exported"));
  await dispatch({ op: "select", ids: [f.id] });
  await p.click("#right-tab-design");

  // ---------- 8: the presenter keeps the status bar in place ----------
  await dispatch({ op: "update", ids: [f.id], patch: { overflow: "vertical" } });
  await dispatch({ op: "createShape", kind: "rectangle", x: 0, y: 800, width: 300, height: 1600, parent: f.id });
  await dispatch({ op: "update", ids: [(await sel())[0]], patch: { absolutePosition: true, name: "Tall body" } });
  await dispatch({ op: "select", ids: [f.id] });
  const pg = await p.evaluate(() => window.__dt.state().page);
  await dispatch({ op: "setFlowStart", page: pg, id: f.id });
  await p.click("button[title='Present']");
  await p.waitForSelector(".presenter");
  await sleep(300);
  const barId = (await named("Status bar")).id;
  const rect = (loc) =>
    loc.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  const scroller = p.locator(`.presenter [data-scroller="${f.id}"]`);
  const fixed = p.locator(`.presenter [data-fixed="${barId}"]`);
  check("the status bar is a fixed layer in the presenter", (await fixed.count()) === 1 && (await scroller.count()) === 1);
  const before = await rect(fixed);
  const sbox = await rect(scroller);
  await p.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
  await p.mouse.wheel(0, 500);
  await sleep(400);
  const after = await rect(fixed);
  const top = await scroller.evaluate((e) => e.scrollTop);
  check("after a wheel scroll the content moved and the status bar did not", top > 100 && Math.abs(after.y - before.y) < 0.5 && Math.abs(after.x - before.x) < 0.5, `scrollTop ${top}, bar ${before.y} -> ${after.y}`);
  await shot("devices-presenter.png");
  await p.keyboard.press("Escape");
  await p.waitForSelector(".presenter", { state: "detached" });

  // ---------- 9: it all persists ----------
  p.on("dialog", (d) => d.accept());
  await sleep(2500);
  const before9 = await doc();
  await p.reload();
  await p.waitForSelector("#dt-canvas");
  await sleep(1200);
  const after9 = await doc();
  const phone = Object.values(after9.nodes).find((n) => n.name === "iPhone 17 Pro");
  check("after a reload the device frame is still there", !!phone && phone.device?.preset === "iphone-17-pro" && phone.device.theme === "dark" && phone.device.applied.join() === "62,0,34,0", JSON.stringify(phone?.device));
  check("so are its parts", Object.values(after9.nodes).filter((n) => n.devicePart).length === Object.values(before9.nodes).filter((n) => n.devicePart).length && !!Object.values(after9.nodes).find((n) => n.devicePart === "statusBar" && n.locked));

  // ---------- Resize by hand keeps the chrome anchored; the rest of the panel ----------
  await dispatch({ op: "select", ids: [phone.id] });
  await dispatch({ op: "update", ids: [phone.id], patch: { width: 430, height: 932 } });
  await sleep(250);
  const d = await doc();
  const sb = Object.values(d.nodes).find((n) => n.devicePart === "statusBar");
  const hi = Object.values(d.nodes).find((n) => n.devicePart === "homeIndicator");
  check("resizing the frame by hand keeps the bar full width and the indicator at the bottom", sb.width === 430 && hi.y === 932 - 13 && Math.abs(hi.x - (430 - 134) / 2) < 0.01, JSON.stringify([sb.width, hi.x, hi.y]));
  check("the padding does not change with a manual resize", d.nodes[phone.id].layout.paddingTop === 72);
  await dispatch({ op: "update", ids: [phone.id], patch: { width: 402, height: 874 } });

  // Plain sizes have no system UI, and a frame can leave its device.
  await p.locator("button:has-text('Resize to preset')").click();
  await p.locator("input[type=search][aria-label='Search size presets']").waitFor();
  await p.keyboard.type("instagram post");
  await p.keyboard.press("Enter");
  await sleep(350);
  const sq = await frame();
  check("a size without system UI removes the device and its parts in one step", sq.width === 1080 && sq.height === 1080 && !sq.device && !(await named("Status bar")) && sq.layout.paddingTop === 10, JSON.stringify([sq.width, !!sq.device, sq.layout?.paddingTop]));
  await focusCanvas();
  await press("Control+z");
  const back = await frame();
  check("one undo brings the phone and its chrome back", back.width === 402 && back.device?.preset === "iphone-17-pro" && !!(await named("Status bar")), `${back.width}`);

  // The safe-area overlay shows for the selected device frame.
  await dispatch({ op: "select", ids: [back.id] });
  const areas = await p.evaluate(() => window.__dt.query({ q: "safeAreas" }));
  check("the safe-area overlay is a dashed line at 62 from the top and 34 from the bottom", areas.length === 1 && areas[0].lines.length === 2 && areas[0].lines[0][1] === back.y + 62 && areas[0].lines[1][1] === back.y + 874 - 34, JSON.stringify(areas[0]?.lines));
  await dispatch({ op: "select", ids: [] });
  check("and none when nothing is selected", (await p.evaluate(() => window.__dt.query({ q: "safeAreas" }))).length === 0);
  await dispatch({ op: "select", ids: [back.id] });
  await shot("devices-panel.png");

  // ---------- Layers drawn on the chrome, copies, deleting a part ----------
  const kids = async () => (await doc()).nodes[back.id].children.map((c) => d2.nodes[c]);
  let d2 = await doc();
  await dispatch({ op: "createShape", kind: "rectangle", x: back.x + 20, y: back.y + 10, width: 200, height: 30, parent: null });
  const drawn = (await sel())[0];
  d2 = await doc();
  check("a rectangle drawn on the status bar goes into the device frame, not the bar", d2.nodes[drawn].parent === back.id, String(d2.nodes[drawn].parent));
  let order = (await kids()).map((n) => n.devicePart ?? (n.id === drawn ? "drawn" : "other"));
  check("it sits below the system UI", order.indexOf("drawn") < order.indexOf("statusBar") && order.slice(-2).join() === "statusBar,homeIndicator", order.join());
  await dispatch({ op: "reorder", ids: [drawn], to: "front" });
  d2 = await doc();
  order = (await kids()).map((n) => n.devicePart ?? (n.id === drawn ? "drawn" : "other"));
  check("bring to front keeps the chrome on top", order.slice(-2).join() === "statusBar,homeIndicator", order.join());
  await dispatch({ op: "delete", ids: [drawn] });

  const barNode = (await nodes()).find((n) => n.devicePart === "statusBar");
  await dispatch({ op: "select", ids: [barNode.id] });
  await focusCanvas();
  await press("Control+d");
  check("Ctrl+D on a chrome part makes no second part", (await allNamed("Status bar")).length === 1 && (await nodes()).filter((n) => n.devicePart === "statusBar").length === 1);
  const clip = await p.evaluate((id) => window.__dt.query({ q: "copy", ids: [id] }), barNode.id);
  const pasted = await p.evaluate((data) => window.__dt.dispatch({ op: "paste", data, parent: null, x: 2000, y: 0 }), clip);
  const copyNode = (await doc()).nodes[pasted.created[0]];
  check("a pasted chrome part is an ordinary unlocked layer", !copyNode.devicePart && !copyNode.locked);
  await dispatch({ op: "delete", ids: [copyNode.id] });

  const homeNode = (await nodes()).find((n) => n.devicePart === "homeIndicator");
  await dispatch({ op: "select", ids: [homeNode.id] });
  await focusCanvas();
  await press("Delete");
  const afterDel = await doc();
  const dev = afterDel.nodes[back.id].device;
  check("deleting the home indicator turns its toggle off and drops the inset", dev.homeIndicator === false && dev.statusBar === true && dev.applied[2] === 0 && afterDel.nodes[back.id].layout.paddingBottom === 10, JSON.stringify([dev.homeIndicator, dev.applied, afterDel.nodes[back.id].layout.paddingBottom]));
  await dispatch({ op: "select", ids: [back.id] });
  await sleep(200);
  check("the Device section shows it unchecked", !(await checkbox("Home indicator").isChecked()));
  await focusCanvas();
  await press("Control+z");
  check("undo brings the indicator back with the toggle", !!(await named("Home indicator")) && (await doc()).nodes[back.id].device.homeIndicator === true);

  // ---------- Switching the device kind ----------
  await dispatch({ op: "select", ids: [back.id] });
  await sleep(200);
  await p.selectOption("select[aria-label=Device]", "pixel-9");
  await sleep(350);
  const px = (await doc()).nodes[back.id];
  check("switching to Pixel 9 renames the frame and sizes it", px.name === "Pixel 9" && px.width === 412 && px.height === 923, JSON.stringify([px.name, px.width, px.height]));
  check("the clock is an Android time, not 9:41", (await named("Time")).text.characters === "12:30", (await named("Time")).text.characters);
  check("the status bar is Android's (camera hole, no Dynamic Island)", !!(await named("Camera")) && !(await named("Dynamic Island")));

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("script completed", false, String(e?.stack ?? e));
}
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
