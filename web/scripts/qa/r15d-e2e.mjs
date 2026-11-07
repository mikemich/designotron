// Round 15, r15d: the first hour of a new user. Enter in side-panel fields commits and gives the keys
// back to the canvas (Y-01), a component from a lone shape has a transparent wrapper (Y-02), Import from
// Figma opens on the dashboard and creates its file only on Import (Y-03), offline chat messages queue
// together (Y-04), Escape leaves the chat box (Y-05), a blank comment name is never saved as
// "Anonymous", the dashboard and chat panel show how to connect Claude, blank files show a compact
// prompt after the first close, labels (Share, Export code, Ask Claude tip), and the card "..." button
// measurement (Y-06). Everything runs twice: from a fresh profile (the tour hints are live) and from
// one that finished the tour. Local servers only: every other request is aborted.
// Usage: E2E_URL=http://127.0.0.1:6741 [E2E_OUT=dir] [AXE=path/to/axe.min.js] [E2E_CONNECTED=1] node scripts/qa/r15d-e2e.mjs
// (E2E_CONNECTED=1: a bridge is running, so Claude shows as connected.)

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:6741";
const OUT = process.env.E2E_OUT ?? "test-results";
const CONNECTED = process.env.E2E_CONNECTED === "1";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
const AXE = [process.env.AXE, "/tmp/claude-0/-home-user-designotron/286bf7bb-781e-5d8f-9708-6c1f94840e4a/scratchpad/qa7/I-a11y/node_modules/axe-core/axe.min.js", path.resolve("node_modules/axe-core/axe.min.js")].find((p) => p && fs.existsSync(p));
const FIX = path.resolve("scripts/fixtures");

const results = [];
let PROFILE = "";
function check(name, ok, detail = "") {
  const label = `[${PROFILE}] ${name}`;
  results.push({ name: label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== "" ? "  - " + String(detail).slice(0, 400) : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch(launch);

/** A new browser profile. `tour` false is a first-time user (no dt:tour-done). */
async function open({ tour, width = 1440, height = 900, scheme = "dark", file = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, acceptDownloads: true });
  if (tour) {
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("dt:tour-done", "1");
      } catch {
        /* no storage */
      }
    });
  }
  const page = await ctx.newPage();
  await page.route("**/*", (r) => (/^(http:\/\/(localhost|127\.0\.0\.1)|data:|blob:|ws:)/.test(r.request().url()) ? r.continue() : r.abort()));
  page.on("pageerror", (e) => check("no page errors", false, String(e)));
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 30000 });
  if (file) await newFile(page);
  return { ctx, page };
}
const newFile = async (page) => {
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas", { timeout: 30000 });
  await sleep(500);
};
const toDashboard = async (page) => {
  await page.evaluate(() => (location.hash = "#/"));
  await page.waitForSelector(".files", { timeout: 15000 });
  await sleep(500);
};
const run = (page, cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const doc = (page) => page.evaluate(() => window.__dt.doc());
const state = (page) => page.evaluate(() => window.__dt.state());
const active = (page) => page.evaluate(() => ({ id: document.activeElement?.id ?? "", tag: document.activeElement?.tagName ?? "", label: document.activeElement?.getAttribute("aria-label") ?? "", cls: document.activeElement?.className ?? "" }));
const shot = (page, name) => page.screenshot({ path: `${OUT}/${PROFILE}-${name}.png` });
const storedFiles = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("keyval-store");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction("keyval").objectStore("keyval").get("dt:index");
          req.onsuccess = () => resolve(req.result ?? []);
          req.onerror = () => reject(req.error);
        };
      }),
  );

async function axeRun(page, label) {
  if (!AXE) return check(`axe: ${label}`, false, "axe-core not found (set AXE)");
  await page.addScriptTag({ path: AXE });
  const res = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] }, resultTypes: ["violations"] });
    return r.violations.map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0].target.join(" ")}`);
  });
  check(`axe: ${label} has 0 violations`, res.length === 0, res.join(" | "));
}

const drawFrame = (page, x, y, w, h) => run(page, { op: "createShape", kind: "frame", x, y, width: w, height: h, parent: null }).then((r) => r.id);
const drawRect = (page, x, y, w, h, parent = null) => run(page, { op: "createShape", kind: "rectangle", x, y, width: w, height: h, parent }).then((r) => r.id);

async function suite(tour) {
  PROFILE = tour ? "returning" : "fresh";

  // ------------------------------------------------------------ Dashboard: Claude status, labels, Y-06
  {
    const { ctx, page } = await open({ tour });
    const note = page.locator(".claude-note");
    if (CONNECTED) {
      await page.waitForFunction(() => !document.querySelector(".claude-note"), null, { timeout: 15000 }).catch(() => {});
      check("dashboard: no 'isn't connected' line once Claude is connected", (await note.count()) === 0);
    } else {
      check("dashboard: says Claude isn't connected", (await note.count()) === 1 && /Claude isn't connected on this computer yet/.test(await note.innerText()), await note.innerText().catch(() => ""));
      check("dashboard: 'How to connect' and 'Watch a replay' are there", (await note.getByRole("button", { name: "How to connect" }).count()) === 1 && (await note.getByRole("button", { name: "Watch a replay" }).count()) === 1);
      check("dashboard: setup steps start closed", (await page.locator(".claude-note-steps").count()) === 0);
      await note.getByRole("button", { name: "How to connect" }).click();
      const steps = await page.locator(".claude-note-steps").innerText().catch(() => "");
      check("dashboard: 'How to connect' opens the steps (install Claude Code, install the bridge)", /Install\s+Claude Code/.test(steps) && /Install the bridge/.test(steps), steps.slice(0, 120));
      check("dashboard: the button reports expanded", (await note.getByRole("button", { name: "How to connect" }).getAttribute("aria-expanded")) === "true");
      await shot(page, "dashboard-dark");
      await axeRun(page, "dashboard (steps open)");
      await note.getByRole("button", { name: "How to connect" }).click();
      check("dashboard: toggling again closes them", (await page.locator(".claude-note-steps").count()) === 0);
    }
    await ctx.close();
  }
  {
    const { ctx, page } = await open({ tour, scheme: "light" });
    if (!CONNECTED) await page.getByRole("button", { name: "How to connect" }).click();
    await shot(page, "dashboard-light");
    await ctx.close();
  }

  // ------------------------------------------------------------ Watch a replay opens a new file with the replay
  if (!CONNECTED) {
    const { ctx, page } = await open({ tour });
    await page.getByRole("button", { name: "Watch a replay" }).click();
    await page.waitForSelector("#dt-canvas", { timeout: 30000 });
    await page.waitForFunction(() => Object.values(window.__dt.doc().nodes).some((n) => n.name === "Landing"), null, { timeout: 15000 }).catch(() => {});
    const d = await doc(page);
    check("replay: 'Watch a replay' makes a new file and plays the demo", Object.values(d.nodes).some((n) => n.name === "Landing"));
    await ctx.close();
  }

  // ------------------------------------------------------------ Y-03: Import from Figma
  {
    const { ctx, page } = await open({ tour });
    const before = (await storedFiles(page)).length;
    const urlBefore = page.url();
    const trigger = page.locator("button[data-focus-key='import-figma']");
    await trigger.click();
    await page.waitForSelector(".figma-dialog", { timeout: 5000 });
    await sleep(300);
    check("figma: the dialog opens on the dashboard (no navigation)", page.url() === urlBefore && (await page.locator(".files").count()) === 1, page.url());
    check("figma: no file was created by opening it", (await storedFiles(page)).length === before, String(before));
    await shot(page, "figma-dialog");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".figma-dialog", { state: "detached", timeout: 5000 });
    await sleep(200);
    const f = await active(page);
    check("figma: Escape closes it and returns focus to 'Import from Figma'", (await page.evaluate(() => document.activeElement?.getAttribute("data-focus-key"))) === "import-figma", JSON.stringify(f));
    check("figma: Escape created no file", (await storedFiles(page)).length === before);

    // A bad link: the error stays in the dialog and no file is created.
    await trigger.click();
    await page.waitForSelector(".figma-dialog");
    await page.locator(".figma-dialog input.textinput").first().fill("https://example.com/not-figma");
    await page.locator(".figma-dialog input[type=password]").fill("figd_test");
    await page.locator(".figma-dialog .btn.primary").click();
    await page.waitForSelector(".figma-dialog .error-box", { timeout: 5000 });
    check("figma: a bad link shows the error in the dialog", /doesn't look like a Figma file link/.test(await page.locator(".figma-dialog .error-box").innerText()));
    check("figma: and creates no file", (await storedFiles(page)).length === before && page.url() === urlBefore);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".figma-dialog", { state: "detached" });

    // Import a JSON export: one new file, named after the Figma file, with its layers, no blank prompt.
    const sample = JSON.parse(fs.readFileSync(path.join(FIX, "figma-sample.json"), "utf8"));
    sample.name = "Brand Kit";
    await trigger.click();
    await page.waitForSelector(".figma-dialog");
    await page.locator(".figma-dialog input[type=file]").setInputFiles({ name: "export.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(sample)) });
    await page.waitForSelector("#dt-canvas", { timeout: 30000 });
    await page.waitForFunction(() => Object.keys(window.__dt.doc().nodes).length > 0, null, { timeout: 15000 });
    await sleep(600);
    const d = await doc(page);
    check("figma: Import opens the editor with the imported layers", Object.keys(d.nodes).length > 3, String(Object.keys(d.nodes).length));
    check("figma: the file is named after the Figma file", d.name === "Brand Kit", d.name);
    check("figma: no blank-file prompt shows", (await page.locator(".empty-prompt, .empty-pill").count()) === 0);
    const warn = await page.locator(".figma-dialog").innerText().catch(() => "");
    check("figma: warnings open the result view in the editor", /Imported \d+ layers into/.test(warn) && /library component/.test(warn), warn.slice(0, 200));
    check("figma: and still no blank-file prompt while the dialog is open", (await page.locator(".empty-prompt, .empty-pill").count()) === 0);
    await shot(page, "figma-result");
    await page.locator(".figma-dialog .btn.primary", { hasText: "Done" }).click();
    await page.waitForSelector(".figma-dialog", { state: "detached" });
    await toDashboard(page);
    const stored = await storedFiles(page);
    check("figma: exactly one new file, named after the Figma file", stored.length === before + 1 && stored.some((e) => e.name === "Brand Kit"), JSON.stringify(stored.map((e) => e.name)));

    // A second import still works (the pending data was cleared) and an empty new file isn't touched.
    await newFile(page);
    check("figma: a plain new file afterwards is blank (nothing pending)", Object.keys((await doc(page)).nodes).length === 0);
    await ctx.close();
  }

  // ------------------------------------------------------------ Y-06: the card "..." button
  {
    const { ctx, page } = await open({ tour, file: true });
    await run(page, { op: "createShape", kind: "rectangle", x: 0, y: 0, width: 100, height: 100, parent: null });
    await sleep(1500);
    await toDashboard(page);
    const card = page.locator(".files-grid .file-card:has(.more)").first();
    await card.hover();
    await sleep(300);
    const m = await page.evaluate(() => {
      const b = document.querySelector(".files-grid .file-card .more");
      const c = b.closest(".file-card");
      const cr = c.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const px = br.right - 1;
      const py = br.top + br.height / 2;
      const top = document.elementFromPoint(px, py);
      return { cardRight: cr.right, btnRight: br.right, btnTop: br.top, cardTop: cr.top, hit: !!top && (top === b || b.contains(top)), shown: getComputedStyle(b).visibility, opacity: getComputedStyle(b).opacity };
    });
    check("Y-06: the '...' button sits inside the card (right edge at least 1 px in)", m.btnRight <= m.cardRight - 1 && m.btnTop >= m.cardTop, JSON.stringify(m));
    check("Y-06: the point at the button's right edge hits the button", m.hit, JSON.stringify(m));
    await ctx.close();
  }

  // ------------------------------------------------------------ Editor: Y-01, Y-02, labels
  {
    const { ctx, page } = await open({ tour, file: true });
    // Labels
    const share = page.getByRole("button", { name: "Share", exact: true });
    check("labels: the Share button shows the text 'Share'", (await share.count()) === 1 && /Share/.test(await share.innerText()) && (await share.isVisible()));
    const exp = page.locator("button.export-code");
    check("labels: Export code says it downloads a .zip", /\.zip/.test((await exp.getAttribute("title")) ?? "") && /React \+ Tailwind/.test((await exp.getAttribute("title")) ?? ""), await exp.getAttribute("title"));
    await run(page, { op: "setDocName", name: "Untitled" });
    await exp.click();
    await page.waitForFunction(() => /Downloaded/.test(document.body.innerText), null, { timeout: 15000 });
    const t1 = await page.evaluate(() => [...document.querySelectorAll(".toast")].map((e) => e.innerText).join("|"));
    check("labels: the export toast for an Untitled file says how to name the project", /Untitled-react\.zip/.test(t1) && /Rename the file in the top bar/.test(t1), t1);
    await sleep(4500);
    await run(page, { op: "setDocName", name: "Poster" });
    await exp.click();
    await page.waitForFunction(() => /Poster-react\.zip/.test(document.body.innerText), null, { timeout: 15000 });
    const t2 = await page.evaluate(() => [...document.querySelectorAll(".toast")].map((e) => e.innerText).join("|"));
    check("labels: a named file's toast is the plain one", /Poster-react\.zip/.test(t2) && !/Rename the file/.test(t2), t2);
    await run(page, { op: "setDocName", name: "Untitled" });

    // Y-01: W 400, Enter, Shift+A, r
    const frame = await drawFrame(page, 100, 100, 260, 300);
    const rect = await drawRect(page, 120, 340, 100, 40, frame);
    await run(page, { op: "select", ids: [frame] });
    await page.waitForSelector("input[aria-label='Width']");
    const W = page.getByLabel("Width").first();
    await W.click();
    await W.fill("400");
    await W.press("Enter");
    await sleep(300);
    let a = await active(page);
    check("Y-01: Enter in W commits 400", (await doc(page)).nodes[frame].width === 400 && (await W.inputValue()) === "400");
    check("Y-01: and focus is on the canvas", a.id === "dt-canvas", JSON.stringify(a));
    await page.keyboard.press("Shift+A");
    await sleep(300);
    check("Y-01: Shift+A then adds auto layout to the frame", !!(await doc(page)).nodes[frame].layout);
    await page.keyboard.press("r");
    await sleep(150);
    check("Y-01: and R selects the rectangle tool", (await page.locator("button[title^='Rectangle'][aria-pressed=true]").count()) === 1);
    await page.keyboard.press("Escape");
    await run(page, { op: "select", ids: [rect] });
    // Tab is unchanged: it keeps going through the panel.
    const X = page.getByLabel("X position").first().or(page.locator("input[aria-label='X']").first());
    if (await X.count()) {
      await X.click();
      await X.fill("33");
      await page.keyboard.press("Tab");
      await sleep(250);
      a = await active(page);
      check("Y-01: Tab commits and moves on to the next field", a.tag === "INPUT" && a.id !== "dt-canvas", JSON.stringify(a));
    } else check("Y-01: Tab test found the X field", false);
    // Escape still reverts and returns to the canvas.
    const W2 = page.getByLabel("Width").first();
    await W2.click();
    await W2.fill("999");
    await W2.press("Escape");
    a = await active(page);
    check("Y-01: Escape reverts and returns to the canvas", a.id === "dt-canvas" && (await doc(page)).nodes[rect].width === 100, JSON.stringify(a));
    // The hex field.
    const hex = page.locator("input[aria-label='Hex colour']").first();
    await hex.focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("336699");
    await page.keyboard.press("Enter");
    await sleep(250);
    a = await active(page);
    check("Y-01: Enter in the hex field commits and returns to the canvas", a.id === "dt-canvas" && (await doc(page)).nodes[rect].fills[0].color.toUpperCase() === "#336699", JSON.stringify(a));
    // In a dialog Enter does not give the keys to the canvas.
    await page.evaluate(() => window.__dt.tool("define_variables", { collection: "Tokens", modes: ["Value"], variables: [{ name: "Gap", type: "number", value: 8 }] }));
    await run(page, { op: "select", ids: [] });
    await page.mouse.click(300, 760);
    await page.getByRole("button", { name: "Open variables" }).first().click();
    await page.waitForSelector(".variables-dialog");
    await sleep(300);
    const cell = page.locator(".variables-dialog tr[data-variable] input").nth(1);
    if (await cell.count()) {
      await cell.focus();
      await page.keyboard.press("Enter");
      await sleep(200);
      a = await active(page);
      check("Y-01: Enter in a Variables dialog cell leaves the canvas alone (dialog stays)", a.id !== "dt-canvas" && (await page.locator(".variables-dialog").count()) === 1, JSON.stringify(a));
    } else check("Y-01: found a Variables dialog cell", false);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".variables-dialog", { state: "detached" }).catch(() => {});
    await ctx.close();
  }

  // ------------------------------------------------------------ Y-02: a lone shape gets a transparent wrapper
  {
    const { ctx, page } = await open({ tour, file: true, scheme: "light" });
    const r = await drawRect(page, 300, 200, 160, 90);
    await run(page, { op: "update", ids: [r], patch: { cornerRadius: 40, fills: [{ type: "solid", color: "#E11D48", opacity: 1, visible: true }] } });
    await run(page, { op: "select", ids: [r] });
    await page.locator("#dt-canvas").focus();
    await page.keyboard.press("Control+Alt+k");
    await sleep(500);
    const d = await doc(page);
    const comp = Object.values(d.nodes).find((n) => n.type === "component");
    check("Y-02: the shape became a component", !!comp);
    check("Y-02: its wrapper has no fills, no clip", !!comp && comp.fills.length === 0 && !comp.clipContent, JSON.stringify(comp?.fills));
    check("Y-02: the rectangle inside keeps its radius", d.nodes[r].cornerRadius === 40 && d.nodes[r].parent === comp.id);
    await run(page, { op: "select", ids: [] });
    await page.keyboard.press("Escape");
    await sleep(300);
    const box = await page.locator(`[data-id="${comp.id}"]`).first().boundingBox();
    const png = await page.screenshot({ type: "png" });
    const px = await page.evaluate(
      async ([b64, bx, by, scale]) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        const g = c.getContext("2d");
        g.drawImage(bmp, 0, 0);
        const at = (x, y) => Array.from(g.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3));
        return { corner: at(bx.x + 3, bx.y + 3), away: at(bx.x - 60, bx.y - 60), centre: at(bx.x + bx.width / 2, bx.y + bx.height / 2) };
      },
      [png.toString("base64"), box, 0, 2],
    );
    const same = px.corner.every((v, i) => Math.abs(v - px.away[i]) <= 2);
    check("Y-02: a pixel just outside the rounded corner is the page background", same, JSON.stringify(px));
    check("Y-02: and the shape's own red still shows in the middle", px.centre[0] > 180 && px.centre[1] < 90, JSON.stringify(px.centre));
    await page.screenshot({ path: `${OUT}/${PROFILE}-component-light.png`, clip: { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 40), width: box.width + 80, height: box.height + 80 } });
    await ctx.close();
  }
  {
    const { ctx, page } = await open({ tour, file: true, scheme: "dark" });
    const r = await drawRect(page, 300, 200, 160, 90);
    await run(page, { op: "update", ids: [r], patch: { cornerRadius: 40 } });
    await run(page, { op: "select", ids: [r] });
    await page.locator("#dt-canvas").focus();
    await page.keyboard.press("Control+Alt+k");
    await sleep(400);
    await run(page, { op: "select", ids: [] });
    await shot(page, "component-dark");
    await ctx.close();
  }

  // ------------------------------------------------------------ Blank-file prompt: full card once, then the pill
  {
    const { ctx, page } = await open({ tour });
    await newFile(page);
    check("blank file: the first one shows the full card", (await page.locator(".empty-prompt").count()) === 1 && (await page.locator(".empty-pill").count()) === 0);
    await shot(page, "blank-card-dark");
    await page.locator(".empty-prompt .empty-close").click();
    await sleep(200);
    check("blank file: X closes it", (await page.locator(".empty-prompt, .empty-pill").count()) === 0);
    await toDashboard(page);
    await newFile(page);
    check("blank file: the next new file shows the compact pill, not the card", (await page.locator(".empty-pill").count()) === 1 && (await page.locator(".empty-prompt").count()) === 0);
    const g = await page.evaluate(() => {
      const p = document.querySelector(".empty-pill").getBoundingClientRect();
      const c = document.getElementById("dt-canvas").getBoundingClientRect();
      const mid = { x: c.left + c.width / 2, y: c.top + c.height / 2 };
      const zoom = document.querySelector(".zoom-indicator")?.getBoundingClientRect();
      return { pill: [p.left, p.top, p.right, p.bottom].map(Math.round), canvas: [c.left, c.top, c.right, c.bottom].map(Math.round), coversMiddle: mid.x >= p.left && mid.x <= p.right && mid.y >= p.top && mid.y <= p.bottom, below: p.top > mid.y + 100, inside: p.left >= c.left && p.right <= c.right && p.bottom <= c.bottom, zoomOverlap: zoom ? !(zoom.right < p.left || zoom.left > p.right || zoom.bottom < p.top || zoom.top > p.bottom) : false, text: document.querySelector(".empty-pill").innerText };
    });
    check("blank file: the pill stays clear of the canvas middle, inside the canvas, away from the zoom chip", !g.coversMiddle && g.below && g.inside && !g.zoomOverlap, JSON.stringify(g));
    check("blank file: the pill reads 'Describe a design for Claude…' and 'Templates'", /Describe a design for Claude…/.test(g.text) && /Templates/.test(g.text), g.text);
    await shot(page, "blank-pill-dark");
    await axeRun(page, "editor with the compact pill");
    await page.locator(".empty-pill").click();
    await sleep(250);
    check("blank file: clicking the pill expands it to the card with the box focused", (await page.locator(".empty-prompt").count()) === 1 && (await page.evaluate(() => document.activeElement?.id)) === "empty-prompt-input");
    await page.locator(".empty-prompt .empty-close").click();
    await ctx.close();
  }
  {
    // The pill at tablet width and light mode.
    const { ctx, page } = await open({ tour, width: 820, height: 1000, scheme: "light" });
    await page.evaluate(() => localStorage.setItem("dt:emptyPrompt", "compact"));
    await newFile(page);
    const g = await page.evaluate(() => {
      const p = document.querySelector(".empty-pill")?.getBoundingClientRect();
      const c = document.getElementById("dt-canvas").getBoundingClientRect();
      return p ? { inside: p.left >= c.left && p.right <= c.right && p.bottom <= c.bottom, mid: p.top > c.top + c.height / 2 } : null;
    });
    check("blank file: at tablet width the pill is inside the canvas, lower half", !!g && g.inside && g.mid, JSON.stringify(g));
    await shot(page, "blank-pill-tablet-light");
    await ctx.close();
  }

  // ------------------------------------------------------------ Y-04 / Y-05 / setup in the chat panel
  if (!CONNECTED) {
    const { ctx, page } = await open({ tour, file: true });
    await page.keyboard.press("Control+/");
    await page.waitForSelector(".chat");
    const box = page.locator(".chat-input textarea");
    await box.fill("first idea");
    await box.press("Enter");
    await sleep(300);
    await box.fill("second idea");
    await box.press("Enter");
    await sleep(500);
    const card = await page.evaluate(() => [...document.querySelectorAll(".queued-prompt")].map((e) => e.innerText).join("\n---\n"));
    check("Y-04: both offline messages are in the 'Waiting to send' card", /first idea/.test(card) && /second idea/.test(card), card);
    const prompt = await page.locator(".empty-prompt").innerText().catch(() => "");
    check("Y-04: the blank-file card shows them too", /first idea/.test(prompt) && /second idea/.test(prompt), prompt.slice(0, 200));
    const open1 = await page.evaluate(() => document.querySelector(".bridge-setup details")?.open ?? null);
    check("setup: with a message waiting, the chat panel's setup steps are open", open1 === true, String(open1));
    await shot(page, "chat-setup-queued");

    // Y-05
    await box.focus();
    await box.fill("a draft I keep");
    await page.keyboard.press("Escape");
    await sleep(200);
    let a = await active(page);
    check("Y-05: Escape leaves the composer for the canvas", a.id === "dt-canvas", JSON.stringify(a));
    check("Y-05: the draft and the panel stay", (await box.inputValue()) === "a draft I keep" && (await page.locator(".chat").count()) === 1);
    await page.keyboard.press("?");
    await page.waitForSelector("[aria-label='Keyboard shortcuts']", { timeout: 3000 }).catch(() => {});
    check("Y-05: then '?' opens the shortcut sheet instead of typing into the box", (await page.locator("[aria-label='Keyboard shortcuts']").count()) === 1 && (await box.inputValue()) === "a draft I keep");
    await page.keyboard.press("Escape");
    await page.waitForSelector("[aria-label='Keyboard shortcuts']", { state: "detached" }).catch(() => {});
    // Escape closes the quick-actions menu first.
    await box.focus();
    await page.locator("button[aria-label='Quick actions']").click();
    await sleep(200);
    await box.focus();
    await page.keyboard.press("Escape");
    await sleep(150);
    check("Y-05: Escape with the quick-actions menu open closes the menu and stays in the box", (await page.locator("[role=menu]").count()) === 0 && (await active(page)).tag === "TEXTAREA");
    await ctx.close();
  }

  // ------------------------------------------------------------ Names: "Anonymous"
  {
    const { ctx, page } = await open({ tour, file: true });
    await drawRect(page, 200, 200, 120, 80);
    const comment = async (text) => {
      await page.keyboard.press("c");
      await page.mouse.click(700, 500);
      await page.waitForSelector(".comment-popover textarea");
      await page.locator(".comment-popover textarea").fill(text);
      return page.locator(".comment-popover input").count();
    };
    const firstInputs = await comment("one");
    check("names: the first comment composer asks for a name", firstInputs >= 1, String(firstInputs));
    await page.locator(".comment-popover .btn.primary", { hasText: "Comment" }).click();
    await sleep(300);
    const d = await doc(page);
    const c1 = Object.values(d.comments ?? {})[0];
    check("names: a blank name makes the comment's author 'Anonymous'", c1?.author === "Anonymous" || c1?.messages?.[0]?.author === "Anonymous", JSON.stringify(c1).slice(0, 200));
    check("names: and 'Anonymous' is not saved", (await page.evaluate(() => localStorage.getItem("dt:userName"))) === null);
    await page.keyboard.press("Escape");
    const secondInputs = await comment("two");
    check("names: the next composer shows the name field again", secondInputs >= 1, String(secondInputs));
    await page.keyboard.press("Escape");
    await ctx.close();
  }
  {
    const { ctx, page } = await open({ tour, file: true });
    await page.evaluate(() => localStorage.setItem("dt:userName", "Anonymous"));
    await drawRect(page, 200, 200, 120, 80);
    await page.keyboard.press("c");
    await page.mouse.click(700, 500);
    await page.waitForSelector(".comment-popover textarea");
    await page.locator(".comment-popover textarea").fill("hi");
    check("names: a stored 'Anonymous' from before brings the name field back", (await page.locator(".comment-popover input").count()) >= 1);
    // A real name is still saved and then not asked for again.
    await page.locator(".comment-popover input").first().fill("Mia");
    await page.locator(".comment-popover .btn.primary", { hasText: "Comment" }).click();
    await sleep(300);
    check("names: a typed name is saved", (await page.evaluate(() => localStorage.getItem("dt:userName"))) === "Mia");
    await ctx.close();
  }

  // ------------------------------------------------------------ Ask Claude tip copy (first-time profile)
  if (!tour) {
    const { ctx, page } = await open({ tour, file: true });
    await drawFrame(page, 100, 100, 200, 200);
    let text = "";
    for (let i = 0; i < 25 && !/Needs Claude Code/.test(text); i++) {
      await sleep(400);
      text = await page.evaluate(() => document.querySelector(".hint-card")?.innerText ?? "");
      if (text && !/Ask Claude/.test(text)) await page.locator(".hint-card button").last().click().catch(() => {});
    }
    check("tip: the Ask Claude tip says what Claude needs", /Needs Claude Code \(Pro or Max\) or an API key; the panel shows how\./.test(text), text.slice(0, 200));
    await ctx.close();
  }
}

try {
  await suite(false);
  await suite(true);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILED:\n" + failed.map((f) => " - " + f.name).join("\n"));
  process.exit(1);
}
