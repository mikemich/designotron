// Round 20, package r20b (versions): a live History list (D-03), a read-only preview before
// restoring, a confirmation before deleting, and "Version N" naming.
// Usage: serve web/dist (`vite preview --port 7251`) and run `node scripts/qa/r20b-e2e.mjs`.
// Env: E2E_URL (default http://127.0.0.1:7251), CHROMIUM (executable path), SHOTS (screenshot dir).
// Local servers only: every other request is aborted. The profile is persistent (a scratch dir).
// Run with LANG=C.UTF-8.

import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:7251";
const SHOTS = process.env.SHOTS ?? "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await fn().catch(() => false)) return true;
    await sleep(100);
  }
  return false;
};

const profile = fs.mkdtempSync(path.join(process.env.PROFILE_ROOT ?? os.tmpdir(), "r20b-profile-"));
const ctx = await chromium.launchPersistentContext(profile, { ...launch, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.route(
  (u) => !/^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) && !/^(data|blob):/.test(u.toString()),
  (r) => r.abort(),
);
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
const errors = [];
const dialogs = [];
const track = (page) => {
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.dismiss().catch(() => {});
  });
  return page;
};
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);

const label = (page) => page.locator(".save-state").textContent();
const dirty = (page) => page.evaluate(() => window.__dt.dirty());
const waitSaved = (page, ms = 10000) => waitFor(async () => (await label(page)).includes("Saved locally") && !(await dirty(page)), ms);
const fileIdOf = (page) => page.evaluate(() => location.hash.replace(/^#\/file\//, ""));
const addRect = (page, name, fill, x = 0) =>
  page.evaluate(
    ([n, f, x]) => window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "rectangle", name: n, x, y: 0, width: 60, height: 60, fill: f }] } }),
    [name, fill, x],
  );
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const nodesOf = (page) => page.evaluate(() => JSON.stringify(window.__dt.doc().nodes));
async function openNew() {
  const page = track(await ctx.newPage());
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(600);
  return page;
}
const idbPut = (page, key, value) =>
  page.evaluate(
    async ([k, v]) => {
      const db = await new Promise((r) => {
        const q = indexedDB.open("keyval-store");
        q.onsuccess = () => r(q.result);
      });
      await new Promise((r) => {
        const tx = db.transaction("keyval", "readwrite");
        tx.objectStore("keyval").put(v, k);
        tx.oncomplete = r;
      });
    },
    [key, value],
  );
const openHistory = async (page) => {
  await page.getByRole("tab", { name: /history/i }).click();
  await page.locator(".history").waitFor();
};
const names = (page) => page.locator(".version .version-name").allTextContents();
/** The row's action buttons are clipped until the row is hovered or focused. */
const rowBtn = async (page, row, title) => {
  await row.hover();
  return row.getByRole("button", { name: title });
};
const rowOf = (page, name) => page.locator(".version").filter({ has: page.locator(".version-name", { hasText: new RegExp("^" + name + "$") }) });
const saveNamed = async (page, name) => {
  const input = page.locator(".history input.textinput").first();
  await input.fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
};

// ---------- 1. An automatic version appears in an open History tab ----------
{
  const page = await openNew();
  const id = await fileIdOf(page);
  await addRect(page, "Seed", "#AA0000");
  check("baseline saves", await waitSaved(page));
  const doc = await page.evaluate(() => window.__dt.engine().save());
  await idbPut(page, `dt:version:${id}:vold`, { doc, assets: {} });
  await idbPut(page, `dt:versions:${id}`, [{ id: "vold", name: "Old milestone", createdAt: Date.now() - 11 * 60000, auto: false }]);
  await page.reload();
  await page.waitForSelector("#dt-canvas");
  await sleep(700);
  await openHistory(page);
  check("the stored version is listed", (await names(page)).includes("Old milestone"));
  await addRect(page, "Edit", "#00AA00", 100);
  check("the automatic version row appears without switching tabs", await waitFor(async () => (await names(page)).some((n) => /^Automatic version/.test(n)), 8000), (await names(page)).join(" | "));
  await page.close();
}

// ---------- 2. Two tabs: a version saved in tab A shows in tab B ----------
{
  const a = await openNew();
  const id = await fileIdOf(a);
  await addRect(a, "Seed", "#AA0000");
  await waitSaved(a);
  const b = track(await ctx.newPage());
  await b.goto(`${URL}/#/file/${id}`);
  await b.waitForSelector("#dt-canvas");
  await sleep(900);
  await openHistory(b);
  await openHistory(a);
  const bannersBefore = await b.locator(".stale-bar").allTextContents();
  await saveNamed(a, "Logo done");
  check("tab B lists 'Logo done' within 2 s", await waitFor(async () => (await names(b)).includes("Logo done"), 2000), (await names(b)).join(" | "));
  const bannersAfter = await b.locator(".stale-bar").allTextContents();
  check("tab B shows no stale or reload banner because of it", !bannersAfter.some((t) => /changed in another tab|Reload/.test(t)) && bannersAfter.length === bannersBefore.length, bannersAfter.join(" | "));
  // Numbering (6): "Logo done" is not numbered, so the first default name is Version 1.
  await saveNamed(a, "");
  check("an empty name saves 'Version 1'", await waitFor(async () => (await names(a)).includes("Version 1")), (await names(a)).join(" | "));
  await saveNamed(a, "");
  check("and then 'Version 2'", await waitFor(async () => (await names(a)).includes("Version 2")), (await names(a)).join(" | "));
  await saveNamed(a, "Version 9");
  await saveNamed(a, "");
  check("after 'Version 9' the next is 'Version 10'", await waitFor(async () => (await names(a)).includes("Version 10")), (await names(a)).join(" | "));
  // Deleting the version in tab A updates B too.
  check("tab B follows the later saves", await waitFor(async () => (await names(b)).includes("Version 10"), 2000));
  await b.close();
  await a.close();
}

// ---------- 3 to 5. Preview, restore from it, delete with confirmation ----------
{
  const page = await openNew();
  await addRect(page, "Box", "#AA0000");
  // A second page with its own colour.
  await page.evaluate(() => window.__dt.dispatch({ op: "addPage", name: "Second" }));
  await addRect(page, "Other", "#0000CC");
  await page.evaluate(() => window.__dt.dispatch({ op: "setPage", id: window.__dt.doc().pages[0].id }));
  await waitSaved(page);
  await openHistory(page);
  await saveNamed(page, "V1");
  await waitFor(async () => (await names(page)).includes("V1"));
  const v1Nodes = await nodesOf(page);
  // Change the design after saving V1.
  const boxId = await page.evaluate(() => Object.values(window.__dt.doc().nodes).find((n) => n.name === "Box").id);
  await page.evaluate((id) => window.__dt.dispatch({ op: "ai", tool: "update_nodes", input: { updates: [{ id, fill: "#22CC22" }] } }), boxId);
  await waitSaved(page);
  const before = await page.evaluate(() => ({ rev: window.__dt.state().docRev, doc: JSON.stringify(window.__dt.doc()), dirty: window.__dt.dirty(), sel: window.__dt.state().selection }));
  const row = rowOf(page, "V1");
  const previewBtn = await rowBtn(page, row, "Preview this version");
  await previewBtn.focus();
  await previewBtn.click();
  const dlg = page.getByRole("dialog", { name: "Preview of V1" });
  await dlg.waitFor();
  check("the preview opens with the version's name", await dlg.isVisible());
  check("the preview draws the page", await waitFor(async () => (await dlg.locator(".vp-svg").count()) === 1));
  const svg = await dlg.locator(".vp-svg").innerHTML();
  check("the preview shows V1's colour and not the new one", /#AA0000/i.test(svg) && !/#22CC22/i.test(svg), `has old ${/#AA0000/i.test(svg)} has new ${/#22CC22/i.test(svg)}`);
  check("the page select appears for two pages", (await dlg.getByLabel("Page").count()) === 1);
  await dlg.getByLabel("Page").selectOption({ label: "Second" });
  check("the second page shows its own colour", await waitFor(async () => /#0000CC/i.test(await dlg.locator(".vp-svg").innerHTML().catch(() => ""))));
  // Zoom and pan, then Fit.
  const g = dlg.locator(".vp-svg > g");
  const t0 = await g.getAttribute("transform");
  const stageBox = await dlg.locator(".vp-stage").boundingBox();
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  await sleep(150);
  const t1 = await g.getAttribute("transform");
  check("Ctrl+wheel zooms", t1 !== t0, `${t0} -> ${t1}`);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.width / 2 + 60, stageBox.y + stageBox.height / 2 + 40, { steps: 4 });
  await page.mouse.up();
  const t2 = await g.getAttribute("transform");
  check("dragging pans", t2 !== t1, `${t1} -> ${t2}`);
  await dlg.getByRole("button", { name: "Fit" }).click();
  await sleep(150);
  check("Fit goes back to the fitted view", (await g.getAttribute("transform")) === t0);
  await dlg.getByLabel("Page").selectOption({ label: "Page 1" }).catch(() => dlg.getByLabel("Page").selectOption({ index: 0 }));
  await dlg.locator(".vp-svg").waitFor();
  await sleep(300);
  await shot(page, "preview-dialog");
  const same = await page.evaluate(() => ({ rev: window.__dt.state().docRev, doc: JSON.stringify(window.__dt.doc()), dirty: window.__dt.dirty(), sel: window.__dt.state().selection }));
  check("previewing leaves the document, revision and selection alone", same.rev === before.rev && same.doc === before.doc && same.dirty === before.dirty && canon(same.sel) === canon(before.sel));
  // Escape closes and focus goes back to the Preview button.
  await page.keyboard.press("Escape");
  check("Escape closes the preview", await dlg.waitFor({ state: "detached" }).then(() => true, () => false));
  check("focus returns to the Preview button", await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Preview this version"));
  // Restore from the preview.
  await (await rowBtn(page, row, "Preview this version")).click();
  await dlg.waitFor();
  await dlg.locator(".vp-svg").waitFor();
  await dlg.getByRole("button", { name: "Restore this version" }).click();
  check("Restore closes the preview", await dlg.waitFor({ state: "detached" }).then(() => true, () => false));
  check("the document equals V1 (canonical nodes)", await waitFor(async () => canon(JSON.parse(await nodesOf(page))) === canon(JSON.parse(v1Nodes))));
  check("a safety version 'Before restoring' was saved", await waitFor(async () => (await names(page)).some((n) => /^Before restoring/.test(n))));
  await page.locator("#dt-canvas").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press("Control+z");
  await sleep(300);
  const undone = await nodesOf(page);
  check("one Ctrl+Z goes back to the edited design", /#22CC22/i.test(undone) && !/#AA0000/i.test(undone.replace(/Other|0000CC/g, "")));

  // Delete: asks first.
  const count0 = (await names(page)).length;
  const delBtn = await rowBtn(page, row, "Delete");
  await delBtn.focus();
  await delBtn.click();
  const confirm = page.getByRole("alertdialog");
  await confirm.waitFor();
  const msg = await confirm.textContent();
  check("deleting asks first, naming the version", /Delete version/.test(msg) && /Delete “V1”\? This can't be undone\./.test(msg), msg);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  check("Cancel keeps the version", (await names(page)).includes("V1") && (await names(page)).length === count0);
  check("focus returns to the Delete button on cancel", await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Delete"));
  await (await rowBtn(page, row, "Delete")).click();
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  check("Delete removes it", await waitFor(async () => !(await names(page)).includes("V1")));
  check("focus stays in the list after deleting", await page.evaluate(() => document.activeElement?.classList.contains("history")));

  // A version that fails to load.
  const id = await fileIdOf(page);
  await idbPut(page, `dt:version:${id}:vbad`, { doc: "{not json", assets: {} });
  const list = await page.evaluate(async (fid) => {
    const db = await new Promise((r) => {
      const q = indexedDB.open("keyval-store");
      q.onsuccess = () => r(q.result);
    });
    return new Promise((r) => {
      const q = db.transaction("keyval").objectStore("keyval").get("dt:versions:" + fid);
      q.onsuccess = () => r(q.result ?? []);
    });
  }, id);
  await idbPut(page, `dt:versions:${id}`, [{ id: "vbad", name: "Broken", createdAt: Date.now(), auto: false }, ...list]);
  await page.reload();
  await page.waitForSelector("#dt-canvas");
  await sleep(700);
  await openHistory(page);
  const brow = rowOf(page, "Broken");
  await (await rowBtn(page, brow, "Preview this version")).click();
  const bdlg = page.getByRole("dialog", { name: "Preview of Broken" });
  check("a version that fails to load says so inside the dialog", await bdlg.getByText("This version couldn't be opened").waitFor().then(() => true, () => false));
  check("Restore is disabled for it", await bdlg.getByRole("button", { name: "Restore this version" }).isDisabled());
  await bdlg.getByRole("button", { name: "Close" }).click();
  await page.close();
}

// ---------- 6. The list refreshes while a preview is open ----------
{
  const page = await openNew();
  await addRect(page, "Box", "#AA0000");
  await waitSaved(page);
  await openHistory(page);
  await saveNamed(page, "First");
  await waitFor(async () => (await names(page)).includes("First"));
  // The second tab only shows the file (previewing is allowed there); the first one saves.
  const fid = await fileIdOf(page);
  const other = track(await ctx.newPage());
  await other.goto(`${URL}/#/file/${fid}`);
  await other.waitForSelector("#dt-canvas");
  await sleep(900);
  await openHistory(other);
  await (await rowBtn(other, rowOf(other, "First"), "Preview this version")).click();
  const dlg = other.getByRole("dialog", { name: "Preview of First" });
  await dlg.locator(".vp-svg").waitFor();
  await saveNamed(page, "While previewing");
  check("the list behind the preview refreshes", await waitFor(async () => (await other.locator(".version .version-name").allTextContents()).includes("While previewing"), 3000));
  check("the preview stays open", await dlg.isVisible());
  await dlg.getByRole("button", { name: "Restore this version" }).click();
  check("Restore in a view-only tab is refused and the preview stays", await other.getByText(/only shows the file/).first().waitFor({ timeout: 3000 }).then(() => true, () => false));
  await other.keyboard.press("Escape");
  await other.close();
  await page.close();
}

check("no browser dialogs fired", dialogs.length === 0, dialogs.join(" | "));
check("no page errors", errors.length === 0, errors.join(" | "));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
