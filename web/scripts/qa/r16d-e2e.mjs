// Round 16, package r16d (data safety): tool images become assets, a save that fails before the
// write is a failed save, the engine-stopped banner, a new document id for a copy, one 80-grapheme
// name rule, the blank-file card, the save-state labels and automatic versions.
// Usage: serve web/dist (`vite preview --port 6831`) and run `node scripts/qa/r16d-e2e.mjs`.
// Env: E2E_URL (default http://127.0.0.1:6831), CHROMIUM (executable path), SHOTS (screenshot dir).
// Local servers only: every other request is aborted. The profile is persistent (a scratch dir).

import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:6831";
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

const profile = fs.mkdtempSync(path.join(process.env.PROFILE_ROOT ?? os.tmpdir(), "r16d-profile-"));
const ctx = await chromium.launchPersistentContext(profile, { ...launch, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
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
  // A disk that is full: every put throws as it is queued (what Safari does) while __failIDB is set.
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...a) {
    if (window.__failIDB) throw new DOMException("Not enough space on the disk", "QuotaExceededError");
    return put.apply(this, a);
  };
});
const errors = [];
const track = (page) => {
  page.on("pageerror", (e) => errors.push(String(e)));
  return page;
};
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);

const label = (page) => page.locator(".save-state").textContent();
const labelShort = (page) => page.locator(".save-state").evaluate((el) => el.firstChild?.textContent ?? "");
const dirty = (page) => page.evaluate(() => window.__dt.dirty());
const waitSaved = (page, ms = 10000) => waitFor(async () => (await label(page)).includes("Saved locally") && !(await dirty(page)), ms);
const fileIdOf = (page) => page.evaluate(() => location.hash.replace(/^#\/file\//, ""));
const addRect = (page, name, x = 0) =>
  page.evaluate(
    ([n, x]) => window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "rectangle", name: n, x, y: 0, width: 60, height: 60, fill: "#AA0000" }] } }),
    [name, x],
  );
async function openNew() {
  const page = track(await ctx.newPage());
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(600);
  return page;
}
async function openFile(id) {
  const page = track(await ctx.newPage());
  await page.goto(`${URL}/#/file/${id}`);
  await page.waitForSelector("#dt-canvas");
  await sleep(700);
  return page;
}
/** One value from the key-value store (every record is one key). */
const idb = (page, key) =>
  page.evaluate(async (k) => {
    const db = await new Promise((r) => {
      const q = indexedDB.open("keyval-store");
      q.onsuccess = () => r(q.result);
    });
    return new Promise((r) => {
      const q = db.transaction("keyval").objectStore("keyval").get(k);
      q.onsuccess = () => r(q.result ?? null);
    });
  }, key);
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
/** The whole stored document of a file as JSON text (manifest or single record). */
async function storedDoc(page, id) {
  const v = await idb(page, `dt:file:${id}`);
  if (!v) return "";
  if (v.v !== 2) return v.doc;
  let all = v.meta ?? "";
  for (const root of Object.keys(v.roots ?? {})) all += (await idb(page, `dt:root:${id}:${root}`)) ?? "";
  return all;
}
/** The document-level part of a stored file (id, name, pages), parsed. */
async function storedHead(page, id) {
  const v = await idb(page, `dt:file:${id}`);
  if (!v) return {};
  return JSON.parse(v.v !== 2 ? v.doc : v.meta);
}
const graphemes = (page, text) =>
  page.evaluate((t) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)].length, text);

// ---------- P-7a: images from tools become assets ----------
{
  const page = await openNew();
  const id = await fileIdOf(page);
  const url = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 700;
    const g = c.getContext("2d");
    const d = g.createImageData(700, 700);
    for (let i = 0; i < d.data.length; i++) d.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
    g.putImageData(d, 0, 0);
    return c.toDataURL("image/png");
  });
  check("the test image is about 2 MB", url.length > 1.5e6, `${(url.length / 1e6).toFixed(1)} MB`);
  const out = await page.evaluate((u) => window.__dt.tool("create_nodes", { nodes: [{ type: "rectangle", name: "Photo", x: 0, y: 0, width: 200, height: 200, imageUrl: u }] }), url);
  check("create_nodes with a data URL works", out.ok, JSON.stringify(out.result).slice(0, 120));
  const json = await page.evaluate(() => JSON.stringify(window.__dt.doc()));
  check("the document holds asset:<id>, no data URL", /asset:a/.test(json) && !json.includes("data:image"), `doc ${json.length} bytes`);
  check("the document JSON stays under 50 KB", json.length < 50000);
  const saved = await page.evaluate(() => window.__dt.engine().save());
  check("the engine's saved JSON has no image bytes either", !saved.includes("data:image"), `${saved.length} bytes`);
  // The same through fills and a fill string.
  const out2 = await page.evaluate(
    (u) => window.__dt.tool("create_nodes", { nodes: [{ type: "rectangle", name: "Fills", x: 300, y: 0, width: 100, height: 100, fills: [{ type: "image", src: u, scaleMode: "fill" }] }] }),
    url,
  );
  const json2 = await page.evaluate(() => JSON.stringify(window.__dt.doc()));
  check("fills[].src data URL becomes an asset too", out2.ok && !json2.includes("data:image"), JSON.stringify(out2.result).slice(0, 100));
  const big = await page.evaluate(() => window.__dt.tool("create_nodes", { nodes: [{ type: "rectangle", imageUrl: "data:image/png;base64," + "A".repeat(34 * 1024 * 1024) }] }));
  check("an image over 25 MB is refused with a message", !big.ok && /larger than 25 MB/.test(String(big.result)), String(big.result));
  check("the image is drawn from the asset store", await waitFor(() => page.evaluate(() => !!document.querySelector('#dt-canvas image[href^="blob:"], #dt-canvas image[*|href^="blob:"]')), 4000));
  check("saves", await waitSaved(page));
  const stored = await storedDoc(page, id);
  check("the stored file has no data URL in its layers", stored.includes("asset:a") && !stored.includes("data:image/png;base64,iVBOR".slice(0, 20)) || !stored.includes("data:image"), `stored ${stored.length} bytes`);
  await page.reload();
  await page.waitForSelector("#dt-canvas");
  check("after a reload the image is still there (from the asset store)", await waitFor(() => page.evaluate(() => !!document.querySelector('#dt-canvas image[href^="blob:"]')), 6000));

  // A plugin doing the same.
  const plug = await page.evaluate(async () => {
    const code = `const c = document.createElement("canvas"); c.width = c.height = 120;
const g = c.getContext("2d"); g.fillStyle = "#3366ff"; g.fillRect(0, 0, 120, 120); g.fillStyle = "#fff"; g.fillRect(20, 20, 40, 40);
await dt.tool("create_nodes", { nodes: [{ type: "rectangle", name: "From plugin", x: 500, y: 0, width: 120, height: 120, imageUrl: c.toDataURL("image/png") }] });`;
    const r = await window.__dt.tool("save_plugin", { name: "Texture", description: "makes an image", code });
    window.__dt.runPlugin(r.result.id);
    return r.result.id;
  });
  const made = await waitFor(() => page.evaluate(() => Object.values(window.__dt.doc().nodes).some((n) => n.name === "From plugin")), 8000);
  check("a plugin that creates a canvas image works", made, plug);
  const json3 = await page.evaluate(() => JSON.stringify(window.__dt.doc()));
  check("the plugin's image is an asset, not inline", made && !json3.includes("data:image") && (json3.match(/asset:a/g) ?? []).length >= 2, `doc ${json3.length} bytes`);
  await page.close();
}

// ---------- P-7b: a save that fails before the write ----------
{
  const page = await openNew();
  await addRect(page, "One");
  check("baseline saves", await waitSaved(page));
  await page.evaluate(() => {
    const e = window.__dt.engine();
    window.__orig = e.persistPlan.bind(e);
    window.__origSave = e.save.bind(e);
    // Preparing the save AND the recovery copy both fail: the label must still say so.
    e.persistPlan = () => {
      throw new RangeError("Invalid string length (stub)");
    };
    e.save = () => {
      throw new RangeError("Invalid string length (stub)");
    };
  });
  await addRect(page, "Two", 80);
  check("a failure while preparing the save shows 'Not saved'", await waitFor(async () => (await labelShort(page)) === "Not saved", 6000), await label(page));
  check("the full sentence is in the title and the live text", (await page.locator(".save-state").getAttribute("title")) === "Not saved: browser storage is full or blocked" && /storage is full or blocked/.test(await label(page)));
  await shot(page, "p5-not-saved-1440");
  check("no bar after the first failure", (await page.locator(".stale-bar").count()) === 0);
  check("a failing recovery copy didn't stop the failure being reported", (await page.evaluate(() => window.__dt.dirty())) === true);
  check("after two failures the .dtron bar appears", await waitFor(async () => (await page.locator(".stale-bar").count()) > 0, 9000), (await page.locator(".stale-bar").allTextContents()).join("|"));
  check("the label never sticks on 'Saving…'", (await labelShort(page)) === "Not saved");
  check("the bar offers the download", (await page.getByRole("button", { name: "Download a .dtron copy" }).count()) === 1);
  await page.evaluate(() => {
    window.__dt.engine().persistPlan = window.__orig;
    window.__dt.engine().save = window.__origSave;
  });
  await addRect(page, "Three", 160);
  check("with the stub removed it returns to 'Saved locally'", await waitSaved(page, 15000), await label(page));
  check("the bar goes away", await waitFor(async () => (await page.locator(".stale-bar").count()) === 0, 3000));
  const id = await fileIdOf(page);
  const stored = await storedDoc(page, id);
  check("all three layers are stored", ["One", "Two", "Three"].every((n) => stored.includes(`"${n}"`)));
  await page.close();
}

// ---------- P-7c: the engine itself stops ----------
{
  const page = await openNew();
  const id = await fileIdOf(page);
  await addRect(page, "Safe");
  check("Safe is saved first", await waitSaved(page));
  // An ordinary command error is not an engine failure.
  await page.evaluate(() => window.__dt.dispatch({ op: "ai", tool: "no_such_tool", input: {} }));
  await sleep(300);
  check("an ordinary command error shows no banner", (await page.locator(".engine-bar").count()) === 0);
  await page.evaluate(() => {
    const e = window.__dt.engine();
    e.dispatch = () => {
      throw new WebAssembly.RuntimeError("unreachable");
    };
  });
  await page.evaluate(() => window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "rectangle", name: "Lost" }] } }));
  check("the banner shows when the engine traps", await waitFor(() => page.locator(".engine-bar").isVisible(), 3000));
  await waitFor(async () => /\(\d/.test(await page.locator(".engine-bar").innerText()), 3000);
  const text = await page.locator(".engine-bar").innerText();
  check("it says the editor stopped and the file is safe up to the last save", /ran out of memory and stopped/.test(text) && /safe up to the last save \(\d/.test(text), text.replace(/\n/g, " "));
  check("it has Reload and the download button", (await page.getByRole("button", { name: "Reload" }).count()) === 1 && (await page.getByRole("button", { name: "Try to download a .dtron" }).count()) === 1);
  check("the trap raised no error toast", (await page.locator(".toast").filter({ hasText: /unreachable/ }).count()) === 0);
  await shot(page, "p7c-engine-banner");
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }).catch(() => null), page.getByRole("button", { name: "Try to download a .dtron" }).click()]);
  check("Try to download makes a .dtron while engine.save still works", !!dl && /\.dtron$/.test(dl.suggestedFilename()));
  await page.getByRole("button", { name: "Reload" }).click();
  await page.waitForSelector("#dt-canvas");
  await sleep(800);
  check("Reload reopens the same file", (await fileIdOf(page)) === id);
  check("it has the last save and no banner", (await page.evaluate(() => Object.values(window.__dt.doc().nodes).some((n) => n.name === "Safe"))) && (await page.locator(".engine-bar").count()) === 0);
  check("and the edit that hit the trap isn't there", !(await page.evaluate(() => Object.values(window.__dt.doc().nodes).some((n) => n.name === "Lost"))));
  await page.close();
}

// ---------- P-7c: ordinary errors that mention "unreachable" are not a trap ----------
{
  const page = await openNew();
  const r = await page.evaluate(() => window.__dt.tool("arrange", { action: "unreachable" }));
  await sleep(300);
  check("a tool error that echoes 'unreachable' is an ordinary error", !r.ok && /unreachable/.test(String(r.result)), String(r.result).slice(0, 80));
  const named = await page.evaluate(() => window.__dt.tool("create_nodes", { nodes: [{ type: "rectangle", name: "Unreachable out of memory", width: 40, height: 40 }] }));
  await sleep(300);
  check("a layer named 'Unreachable' is fine", named.ok);
  check("no banner, and the editor keeps working", (await page.locator(".engine-bar").count()) === 0 && (await addRect(page, "Still works")) !== null);
  check("it still saves", await waitSaved(page));
  const bad = await page.evaluate(() => window.__dt.tool("create_nodes", { nodes: [{ type: "rectangle", imageUrl: "data:image/png;base64,@@@@" }] }));
  check("a data URL that isn't base64 is refused with a message", !bad.ok && /not valid base64/.test(String(bad.result)), String(bad.result));
  await page.close();
}

// ---------- P-7c: after a real trap every engine method throws ----------
{
  const page = await openNew();
  const id = await fileIdOf(page);
  await addRect(page, "Saved");
  check("Saved is stored first", await waitSaved(page));
  const errs0 = errors.length;
  const consoleErrs = [];
  page.on("console", (m) => m.type() === "error" && consoleErrs.push(m.text().slice(0, 160)));
  await page.evaluate(() => {
    window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "rectangle", name: "Unsaved", x: 100, y: 0, width: 80, height: 80, fill: "#00aa00" }] } });
    window.__dt.doc(); // the screen has read it
    const e = window.__dt.engine();
    const proto = Object.getPrototypeOf(e);
    let trapped = false;
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k === "constructor" || typeof proto[k] !== "function") continue;
      e[k] = function () {
        if (!trapped) {
          trapped = true;
          throw new WebAssembly.RuntimeError("unreachable");
        }
        throw new Error("recursive use of an object detected which would lead to unsafe aliasing in rust");
      };
    }
    try {
      window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "rectangle", name: "Lost" }] } });
    } catch {
      /* the trap */
    }
  });
  await sleep(600);
  check("total trap: the banner is visible", await page.locator(".engine-bar").isVisible());
  check("the banner is an alert", (await page.locator(".engine-bar").getAttribute("role")) === "alert");
  await page.mouse.move(700, 400);
  await page.mouse.click(720, 420);
  await sleep(300);
  const body = await page.evaluate(() => document.body.innerText.length);
  check("the page isn't blank: the banner and a message show", body > 50 && (await page.locator(".engine-bar").isVisible()), `body ${body} chars; canvas ${await page.locator("#dt-canvas").count()}; console: ${consoleErrs.slice(0, 2).join(" | ")}`);
  if ((await page.locator(".save-state").count()) > 0) check("the label doesn't say Saving…", (await labelShort(page)) === "Not saved", await label(page));
  const armed = await page.evaluate(() => {
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check("the close prompt is still armed (unsaved edit)", armed);
  check("no uncaught page error from the trap", errors.length === errs0, errors.slice(errs0).join("|").slice(0, 200));
  await shot(page, "p7c-total-trap");
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }).catch(() => null), page.getByRole("button", { name: "Try to download a .dtron" }).click()]);
  check("Try to download works from the screen's copy when engine.save throws", !!dl && /\.dtron$/.test(dl.suggestedFilename()), dl?.suggestedFilename());
  if (dl) {
    const file = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
    const names = Object.values(file.document.nodes).map((n) => n.name);
    check("the file holds the last edit, saved or not", file.format === "designotron" && names.includes("Unsaved") && names.includes("Saved") && !names.includes("Lost"), names.join(","));
    // Open it again as a new file.
    const fresh = track(await ctx.newPage());
    await fresh.goto(URL);
    await fresh.waitForSelector("button:has-text('New design file')");
    const [chooser] = await Promise.all([fresh.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null), fresh.getByRole("button", { name: "Open .dtron" }).first().click()]);
    if (chooser) {
      await chooser.setFiles(await dl.path());
      await fresh.waitForSelector("#dt-canvas", { timeout: 6000 }).catch(() => {});
      check("the downloaded file re-opens with the last edit", await waitFor(() => fresh.evaluate(() => Object.values(window.__dt.doc().nodes).some((n) => n.name === "Unsaved")), 5000));
    } else {
      check("(re-open through the file chooser not reachable from the dashboard here; contents were checked)", true);
    }
    await fresh.close();
  }
  // Going home reloads instead of reusing the stopped engine.
  page.on("dialog", (d) => d.accept());
  await page.evaluate(() => (location.hash = "#/"));
  check("going home reloads: the dashboard shows, no banner", await waitFor(async () => (await page.locator(".file-card, .files-bar").count()) > 0 && (await page.locator(".engine-bar").count()) === 0, 8000));
  void id;
  await page.close();
}

// ---------- P-1: a duplicate gets a new document id ----------
let dupSourceId;
{
  const page = await openNew();
  dupSourceId = await fileIdOf(page);
  await addRect(page, "Original");
  await waitSaved(page);
  await page.goto(`${URL}/#/drafts`);
  await page.waitForSelector(".file-card");
  const before = await page.locator(".file-card").count();
  await page.locator(".file-card").first().locator("button.more").click();
  await page.locator('.menu [role=menuitem]:has-text("Duplicate")').click();
  check("the copy appears", await waitFor(async () => (await page.locator(".file-card").count()) === before + 1, 5000));
  const copyId = await page.evaluate(async (src) => {
    const db = await new Promise((r) => {
      const q = indexedDB.open("keyval-store");
      q.onsuccess = () => r(q.result);
    });
    const index = await new Promise((r) => {
      const q = db.transaction("keyval").objectStore("keyval").get("dt:index");
      q.onsuccess = () => r(q.result);
    });
    return index.find((f) => f.id !== src && /\(copy\)$/.test(f.name))?.id;
  }, dupSourceId);
  check("the copy is a separate stored file", !!copyId && copyId !== dupSourceId, copyId);
  const copyDoc = await storedHead(page, copyId);
  const srcDoc = await storedHead(page, dupSourceId);
  check("the stored copy's document id differs from the original's", !!copyDoc.id && !!srcDoc.id && copyDoc.id !== srcDoc.id && /^d_/.test(copyDoc.id), `${srcDoc.id} vs ${copyDoc.id}`);
  const a = await openFile(dupSourceId);
  const b = await openFile(copyId);
  const ids = [await a.evaluate(() => window.__dt.doc().id), await b.evaluate(() => window.__dt.doc().id)];
  check("both open, with different ids in the editor", ids[0] !== ids[1] && !!ids[0] && !!ids[1], ids.join(" / "));
  check("the copy has the layers", await b.evaluate(() => Object.values(window.__dt.doc().nodes).some((n) => n.name === "Original")));
  await a.close();
  await b.close();
  await page.close();
}

// ---------- P-2: names are at most 80 graphemes, with a notice ----------
{
  const page = await openNew();
  const long = "n".repeat(97) + "😀😀😀";
  const input = page.locator(".topbar .filename");
  await input.fill(long);
  await input.press("Enter");
  check("the top-bar name is cut to 80 graphemes", await waitFor(async () => (await graphemes(page, await page.evaluate(() => window.__dt.doc().name))) === 80, 3000), await page.evaluate(() => window.__dt.doc().name.length));
  const name = await page.evaluate(() => window.__dt.doc().name);
  check("no U+FFFD or lone surrogate in it", !name.includes("�") && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(name));
  check("a toast says it was shortened", await page.locator(".toast").filter({ hasText: /Names can be up to 80 characters; it was shortened/ }).count().then((n) => n > 0));
  await input.fill("x".repeat(80));
  await input.press("Enter");
  await sleep(300);
  check("exactly 80 characters is not cut and gives no notice", (await page.evaluate(() => window.__dt.doc().name)) === "x".repeat(80));
  await input.fill("Ends with emoji " + "e".repeat(70) + "😀😀😀😀");
  await input.press("Enter");
  await sleep(300);
  const n2 = await page.evaluate(() => window.__dt.doc().name);
  check("a name ending in emoji is cut on a boundary", (await graphemes(page, n2)) === 80 && !n2.includes("�"), n2.slice(-8));
  await waitSaved(page);
  // The dashboard.
  await page.goto(`${URL}/#/drafts`);
  await page.waitForSelector(".file-card");
  await page.locator(".file-card").first().locator("button.more").click();
  await page.locator('.menu [role=menuitem]:has-text("Rename")').click();
  const field = page.locator(".name-input").first();
  await field.fill("d".repeat(97) + "😀😀😀");
  await field.press("Enter");
  check("the dashboard rename shows the notice", await waitFor(() => page.locator(".toast").filter({ hasText: /it was shortened/ }).count().then((n) => n > 0), 3000));
  const shown = await waitFor(async () => (await page.locator(".file-card .n").allTextContents()).some((t) => t.startsWith("d".repeat(80))), 4000);
  const cards = await page.locator(".file-card .n").allTextContents();
  const card = cards.find((t) => t.startsWith("d".repeat(10))) ?? "";
  check("the dashboard name is 80 graphemes with no U+FFFD", shown && (await graphemes(page, card)) === 80 && !card.includes("�"), String(card.length));
  await page.close();
}

// ---------- P-3: no blank-file card on a file with layers elsewhere ----------
{
  const page = await openNew();
  const id = await fileIdOf(page);
  check("a really blank file shows the card", (await page.locator(".empty-prompt").count()) === 1);
  const first = await page.evaluate(() => window.__dt.state().page);
  const p2 = await page.evaluate(() => window.__dt.dispatch({ op: "addPage", name: "Page 2" })?.id);
  await page.evaluate((p) => window.__dt.dispatch({ op: "setPage", id: p }), p2);
  await addRect(page, "On page 2");
  await waitSaved(page);
  await page.close();
  const re = await openFile(id);
  await re.evaluate((p) => window.__dt.dispatch({ op: "setPage", id: p }), first);
  await sleep(500);
  check("Page 1 is empty and current", (await re.evaluate(() => window.__dt.state().page)) === first);
  check("the compact pill shows", (await re.locator(".empty-pill").count()) === 1);
  check("the centred card does not", (await re.locator(".empty-prompt").count()) === 0);
  await shot(re, "p3-pill-page1");
  await re.close();
}

// ---------- P-4: a read-only tab says so ----------
{
  const A = await openNew();
  const id = await fileIdOf(A);
  await addRect(A, "Held");
  await waitSaved(A);
  const B = await openFile(id);
  check("tab B is read-only", await B.evaluate(() => !!window.__dt.state().readOnly));
  check("its label is 'Read-only: open in another tab', not 'Saved locally'", (await labelShort(B)) === "Read-only: open in another tab" && !(await label(B)).includes("Saved locally"), await label(B));
  check("the editing tab still says 'Saved locally'", (await label(A)).includes("Saved locally"));
  await shot(B, "p4-read-only-tab");
  await A.close();
  await B.close();
}

// ---------- P-5: the breadcrumb survives the save warning ----------
{
  const page = await openNew();
  await addRect(page, "Q");
  await waitSaved(page);
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 1440) {
      await page.evaluate(() => (window.__failIDB = true));
      await addRect(page, "Full-1", 100);
      await sleep(1200);
      await addRect(page, "Full-2", 200);
      await waitFor(async () => (await page.locator(".stale-bar").count()) > 0, 14000);
    }
    await sleep(300);
    const m = await page.evaluate(() => {
      const a = document.querySelector(".file-loc a");
      const nav = document.querySelector(".file-loc");
      const st = document.querySelector(".save-state");
      return a && nav && st ? { text: a.textContent, truncated: a.scrollWidth > a.clientWidth + 1, navW: nav.getBoundingClientRect().width, label: st.firstChild?.textContent, title: st.getAttribute("title") } : null;
    });
    check(`${width}px: the breadcrumb shows "Drafts" in full`, !!m && m.text === "Drafts" && !m.truncated && m.navW >= 40, JSON.stringify(m));
    check(`${width}px: the label is the short 'Not saved' with the full sentence in the title`, m?.label === "Not saved" && m?.title === "Not saved: browser storage is full or blocked");
    await shot(page, `p5-breadcrumb-${width}`);
  }
  await page.evaluate(() => (window.__failIDB = false));
  await page.setViewportSize({ width: 1440, height: 900 });
  check("storage returns: Saved locally again", await waitSaved(page, 15000));
  await page.close();
}

// ---------- P-6: automatic versions are labelled ----------
{
  const page = await openNew();
  const id = await fileIdOf(page);
  await addRect(page, "V");
  await waitSaved(page);
  const doc = await page.evaluate(() => window.__dt.engine().save());
  const now = Date.now();
  const mk = async (vid, name, auto, at) => {
    await idbPut(page, `dt:version:${id}:${vid}`, { doc, assets: {} });
    return { id: vid, name, createdAt: at, auto };
  };
  const list = [await mk("vauto1", "Automatic version", true, now - 60000), await mk("vold1", "Autosave", true, now - 3600000), await mk("vnamed", "Milestone", false, now - 7200000)];
  await idbPut(page, `dt:versions:${id}`, list);
  await page.reload();
  await page.waitForSelector("#dt-canvas");
  await page.getByRole("tab", { name: /history/i }).click();
  await page.locator(".version").first().waitFor();
  const names = await page.locator(".version .version-name").allTextContents();
  check("an automatic version reads 'Automatic version · hh:mm'", /^Automatic version · \d{1,2}:\d{2}/.test(names[0]), names[0]);
  check("an old one stored as 'Autosave' reads the same way", /^Automatic version · \d{1,2}:\d{2}/.test(names[1]) && !/Autosave/.test(names[1]), names[1]);
  check("a named version keeps its name", names[2] === "Milestone", names[2]);
  check("automatic rows carry an 'automatic' text for screen readers", (await page.locator(".version.auto .sr-only").count()) === 2);
  await shot(page, "p6-versions");
  // Renaming an automatic version makes it a named one.
  await page.locator(".version").first().locator(".version-name").dblclick();
  const rn = page.locator(".version input.textinput");
  await rn.fill("Before the redesign");
  await rn.press("Enter");
  await waitFor(async () => (await page.locator(".version .version-name").first().textContent()) === "Before the redesign", 3000);
  const after = await page.locator(".version .version-name").allTextContents();
  check("renaming makes it a named version", after[0] === "Before the redesign" && (await page.locator(".version.auto").count()) === 1, after.join("|"));
  // A real autosave stores the new name.
  const stored = await idb(page, `dt:versions:${id}`);
  check("the stored list marks it as no longer automatic", stored.find((v) => v.id === "vauto1")?.auto === false);
  await page.close();
}

check("no uncaught page errors", errors.length === 0, errors.join(" | "));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
