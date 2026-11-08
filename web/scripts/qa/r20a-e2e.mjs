// Round 20, r20a: storage start-up (D-01), plain errors (D-04), Figma import errors (D-02), files from a
// newer version (D-06) and the dashboard right-click menu, in the real editor.
//   1. The browser refuses IndexedDB (the `window.indexedDB` getter throws; `IDBFactory.prototype.open`
//      throws): the dashboard shows the "isn't keeping files" banner, no page error, New file opens.
//   2. Quota on a write: duplicate and rename show "storage is full", never "Quota".
//   3. Figma import with no bridge (the direct fetch is aborted, the proxy target 7244 is dead): "Couldn't
//      reach the Figma API". A non-JSON .json file: "isn't valid JSON".
//   4. A version 99 file opens with a warning; one with an unknown trigger gives the newer-version error.
//   5. Right-click and Shift+F10 on file and folder cards.
//   6. Download .dtron of "Emoji 🎨 x" keeps its name.
//
// Local only: serves web/dist with `vite preview` (DESIGNOTRON_PORT=7244 with nothing listening) and aborts
// every non-local request. Run with LANG=C.UTF-8.
//   cd web && npm run build && LANG=C.UTF-8 node scripts/qa/r20a-e2e.mjs
// Env: E2E_PORT (7241) E2E_URL (an editor that is already served) E2E_DIST (dist) E2E_OUT (screenshots)

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 7241);
const BASE = process.env.E2E_URL ?? `http://127.0.0.1:${PORT}/`;
const DIST = process.env.E2E_DIST ?? "dist";
const OUT = process.env.E2E_OUT ?? "/tmp/r20a-shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).slice(0, 500) : ""}`);
};

const children = [];
process.on("exit", () => children.forEach((c) => c.kill()));
if (!process.env.E2E_URL) {
  const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--outDir", DIST, "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"], {
    stdio: "ignore",
    env: { ...process.env, DESIGNOTRON_PORT: "7244" },
  });
  children.push(vite);
}
for (let i = 0; ; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {
    /* not yet */
  }
  if (i > 100) {
    console.error(`no editor at ${BASE}`);
    process.exit(2);
  }
  await sleep(200);
}

const launchOpts = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launchOpts.executablePath = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(launchOpts);
const LOCAL = /^(https?:\/\/(localhost|127\.0\.0\.1)[:/])|^(data|blob|ws|wss):/;
const dialogs = [];

/** A fresh context (empty storage) with the tour off and `init` run before every page script. */
async function open(init) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
  await ctx.route((u) => !LOCAL.test(u.toString()), (r) => r.abort());
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.dismiss().catch(() => {});
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/bridge|Failed to load resource|WebSocket|net::ERR|\/figma|\bfetch\b/i.test(m.text())) errors.push("console: " + m.text().slice(0, 200));
  });
  await page.goto(BASE);
  return { ctx, page, errors };
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png") });
const toastText = (page) => page.locator(".toast").first().innerText();
const BANNER = "isn't keeping files";

// ---------- 1. storage refused ----------
for (const [label, init] of [
  [
    "the indexedDB getter throws",
    () => Object.defineProperty(window, "indexedDB", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } }),
  ],
  [
    "IDBFactory.open throws",
    () => {
      IDBFactory.prototype.open = function () {
        throw new DOMException("denied", "SecurityError");
      };
    },
  ],
]) {
  const { ctx, page, errors } = await open(init);
  let ok = true;
  try {
    await page.waitForSelector(`text=${BANNER}`, { timeout: 5000 });
  } catch {
    ok = false;
  }
  check(`storage refused (${label}): the dashboard shows the banner`, ok);
  await shot(page, "storage-" + (label.includes("getter") ? "getter" : "open"));
  await page.click("button:has-text('New design file')");
  let editor = true;
  try {
    await page.waitForSelector("#dt-canvas", { timeout: 8000 });
  } catch {
    editor = false;
  }
  check(`storage refused (${label}): New design file opens the editor`, editor);
  check(`storage refused (${label}): no page errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ---------- 2. quota ----------
{
  const { ctx, page, errors } = await open();
  await page.waitForSelector(".files");
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(800);
  await page.evaluate(() => (location.hash = "#/"));
  await page.waitForSelector(".file-card:has(.more)", { timeout: 8000 });
  await sleep(500);
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
  });
  const card = page.locator(".file-card:has(.more)").first();
  await card.hover();
  await card.locator(".more").click();
  await page.click("[role=menuitem]:has-text('Duplicate')");
  await page.waitForSelector(".toast.error", { timeout: 5000 });
  let t = await toastText(page);
  check("quota: duplicate says the storage is full", /storage is full/.test(t) && !/quota/i.test(t), t);
  await shot(page, "quota-toast");
  await sleep(300);
  await card.hover();
  await card.locator(".more").click();
  await page.click("[role=menuitem]:has-text('Rename')");
  await page.locator(".file-card input").first().fill("Renamed");
  await page.keyboard.press("Enter");
  await sleep(600);
  t = await toastText(page).catch(() => "");
  check("quota: rename says the storage is full", /storage is full/.test(t) && !/quota/i.test(t), t);
  // The raw error stays in the console (and only there).
  const other = errors.filter((x) => !/QuotaExceededError/.test(x));
  check("quota: no page errors", other.length === 0, other.join(" | "));
  await ctx.close();
}

// ---------- 3. Figma import with no bridge ----------
{
  const { ctx, page } = await open();
  await page.waitForSelector(".files");
  await page.click("button[data-focus-key='import-figma']");
  await page.waitForSelector(".figma-dialog");
  await page.locator(".figma-dialog input.textinput").first().fill("https://www.figma.com/design/AbCdEf123/Test");
  await page.locator(".figma-dialog input[type=password]").fill("figd_test");
  await page.locator(".figma-dialog .btn.primary").click();
  await page.waitForSelector(".figma-dialog .error-box", { timeout: 15000 });
  const e = await page.locator(".figma-dialog .error-box").innerText();
  check("figma: no bridge shows 'Couldn't reach the Figma API'", /Couldn't reach the Figma API/.test(e), e);
  await shot(page, "figma-unreachable");
  // A file that isn't JSON at all.
  const bad = path.join(OUT, "not-json.json");
  fs.writeFileSync(bad, "this is not json {");
  await page.locator(".figma-dialog input[type=file]").setInputFiles(bad);
  await page.waitForFunction(() => /valid JSON/.test(document.querySelector(".figma-dialog .error-box")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
  const e2 = await page.locator(".figma-dialog .error-box").innerText();
  check("figma: a non-JSON file says it isn't valid JSON", /isn't valid JSON/.test(e2) && !/position|Unexpected/.test(e2), e2);
  await shot(page, "figma-not-json");
  await ctx.close();
}

// ---------- 4. newer files ----------
{
  const { ctx, page } = await open();
  await page.waitForSelector(".files");
  const future = path.resolve("scripts/fixtures/future.dtron");
  const chooser = page.waitForEvent("filechooser");
  await page.click("button:has-text('Open .dtron')");
  await (await chooser).setFiles(future);
  await page.waitForSelector("#dt-canvas", { timeout: 10000 });
  let t = "";
  try {
    await page.waitForSelector(".toast", { timeout: 3000 });
    t = await toastText(page);
  } catch {
    /* no toast */
  }
  check("newer file: a version 99 file opens with a 'newer version' warning", /newer version/.test(t), t);
  await shot(page, "newer-warning");
  await page.evaluate(() => (location.hash = "#/"));
  await page.waitForSelector(".files");
  // A crafted file whose trigger this editor doesn't know.
  const src = JSON.parse(fs.readFileSync(future, "utf8"));
  const nodes = src.document.nodes;
  let patched = false;
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const k of Object.keys(v)) {
      if (k === "trigger" && typeof v[k] === "string") (v[k] = "onTeleport", (patched = true));
      else walk(v[k]);
    }
  };
  walk(nodes);
  if (!patched) Object.values(nodes)[0].interactions = [{ trigger: "onTeleport", action: "back" }];
  src.version = 1;
  const crafted = path.join(OUT, "teleport.dtron");
  fs.writeFileSync(crafted, JSON.stringify(src));
  const chooser2 = page.waitForEvent("filechooser");
  await page.click("button:has-text('Open .dtron')");
  await (await chooser2).setFiles(crafted);
  await page.waitForSelector(".toast.error", { timeout: 8000 });
  t = await toastText(page);
  check("newer file: an unknown trigger says 'newer version', not 'damaged'", /newer version/.test(t) && !/damaged/.test(t), t);
  check("newer file: and stays on the dashboard", (await page.locator("#dt-canvas").count()) === 0);
  // The same file dropped onto the dashboard: also the newer-version message, not a Figma hint.
  await page.evaluate(async (text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], "teleport.dtron", { type: "application/json" }));
    const dash = document.querySelector(".dash");
    for (const type of ["dragenter", "dragover", "drop"]) dash.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, fs.readFileSync(crafted, "utf8"));
  await page.waitForFunction(() => /newer version|Figma export/.test(document.querySelector(".toast.error")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
  t = await toastText(page);
  check("newer file: dropped onto the dashboard it says 'newer version', not Figma export", /newer version/.test(t) && !/Figma/.test(t), t);
  await ctx.close();
}

// ---------- 5. right-click menu ----------
{
  const { ctx, page } = await open();
  await page.waitForSelector(".files");
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(800);
  await page.evaluate(() => (location.hash = "#/"));
  await page.waitForSelector(".file-card:has(.more)", { timeout: 8000 });
  // A folder to right-click as well.
  await page.click("button[aria-label='New project']");
  await sleep(300);
  await page.keyboard.type("Proj");
  await page.keyboard.press("Enter");
  await sleep(600);
  const labels = (page) => page.locator("[role=menu] [role=menuitem]").allInnerTexts();
  const card = page.locator(".file-card:has(.more)").first();
  await card.click({ button: "right" });
  await page.waitForSelector("[role=menu]");
  const L = (await labels(page)).map((s) => s.trim());
  check("right-click file card: the menu has the file actions", ["Open", "Open in new tab", "Rename", "Duplicate", "Move to…", "Delete"].every((x) => L.includes(x)), L.join(","));
  await shot(page, "file-card-menu");
  await page.keyboard.press("Escape");
  await page.waitForSelector("[role=menu]", { state: "detached" });
  check("right-click file card: Escape closes it and focus returns to the card", await page.evaluate(() => !!document.activeElement?.closest(".file-card")));
  // Shift+F10 on the focused card.
  await card.locator(".file-open").focus();
  await page.keyboard.press("Shift+F10");
  let menu = true;
  try {
    await page.waitForSelector("[role=menu]", { timeout: 2000 });
  } catch {
    menu = false;
  }
  check("Shift+F10 on a focused file card opens the menu", menu);
  await page.keyboard.press("Escape");
  await page.waitForSelector("[role=menu]", { state: "detached" }).catch(() => {});
  // Open in new tab.
  await card.click({ button: "right" });
  const popup = ctx.waitForEvent("page", { timeout: 8000 });
  await page.click("[role=menuitem]:has-text('Open in new tab')");
  const p2 = await popup;
  await p2.waitForLoadState();
  check("Open in new tab opens the file's own address", /#\/file\//.test(p2.url()), p2.url());
  await p2.close();
  // Folder card.
  await page.locator("nav[aria-label=Files]").getByText("Proj", { exact: true }).first().click();
  await page.waitForSelector("button:has-text('New folder')");
  await page.click("button:has-text('New folder')");
  await sleep(300);
  await page.keyboard.type("Sub");
  await page.keyboard.press("Enter");
  await sleep(600);
  const fcard = page.locator(".folder-card").first();
  if (await fcard.count()) {
    await fcard.click({ button: "right" });
    await page.waitForSelector("[role=menu]");
    const F = (await labels(page)).map((s) => s.trim());
    check("right-click folder card: Open, Rename, Move to…, Delete", ["Open", "Rename", "Move to…", "Delete"].every((x) => F.includes(x)), F.join(","));
    await page.keyboard.press("Escape");
    await page.waitForSelector("[role=menu]", { state: "detached" });
    check("right-click folder card: Escape returns focus to the card", await page.evaluate(() => !!document.activeElement?.closest(".folder-card")));
    await fcard.locator(".folder-open").focus();
    await page.keyboard.press("Shift+F10");
    let fm = true;
    try {
      await page.waitForSelector("[role=menu]", { timeout: 2000 });
    } catch {
      fm = false;
    }
    check("Shift+F10 on a focused folder card opens the menu", fm);
    await page.keyboard.press("Escape");
  } else check("a folder card exists to test", false);
  await page.evaluate(() => (location.hash = "#/"));
  await page.waitForSelector(".file-card:has(.more)", { timeout: 8000 });
  // Right-click inside a rename field keeps the browser menu (no app menu).
  await card.hover();
  await card.locator(".more").click();
  await page.click("[role=menuitem]:has-text('Rename')");
  await page.locator(".file-card input").first().click({ button: "right" });
  await sleep(300);
  check("right-click in a rename field opens no app menu", (await page.locator("[role=menu]").count()) === 0);
  await page.keyboard.press("Escape");
  await ctx.close();
}

// ---------- 6. download name with an emoji ----------
{
  const { ctx, page } = await open();
  await page.waitForSelector(".files");
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(800);
  const name = "Emoji \u{1F3A8} x";
  await page.evaluate((n) => window.__dt.dispatch({ op: "setDocName", name: n }), name);
  await sleep(400);
  const dl = page.waitForEvent("download", { timeout: 10000 });
  await page.keyboard.press("Shift+Control+s");
  const d = await dl.catch(() => null);
  check("download .dtron keeps the emoji in the name", !!d && d.suggestedFilename() === name + ".dtron", d?.suggestedFilename());
  await ctx.close();
}

check("no window.confirm, prompt or alert fired", dialogs.length === 0, dialogs.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
