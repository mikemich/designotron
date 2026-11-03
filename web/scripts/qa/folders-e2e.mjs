// Projects and nested folders on the files dashboard: legacy files in Drafts, nesting and the
// tree's ARIA levels, folder kept across saves/renames, create/duplicate/import/template into the
// current folder, Move to… (keyboard, cycle refusal), drag and drop, search with locations,
// delete-to-Drafts with in-page dialogs, two tabs, tree keyboard, phone sheet, copy links.
// Usage: E2E_URL=http://localhost:5601 node scripts/qa/folders-e2e.mjs (dev server running).
// Env: E2E_URL, CHROMIUM (executable path), E2E_SHOTS (a directory: also save screenshots there).

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const SHOTS = process.env.E2E_SHOTS;
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
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
// Nothing may leave the machine.
await context.route(/^https?:\/\/(?!(127\.0\.0\.1|localhost)[:/])/, (r) => r.abort());
await context.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
const errors = [];
const dialogs = [];
const track = (pg) => {
  pg.on("pageerror", (e) => errors.push(String(e)));
  pg.on("dialog", (d) => {
    dialogs.push(d.type());
    d.dismiss().catch(() => {});
  });
  return pg;
};
const p = track(await context.newPage());

const idb = (pg, key) =>
  pg.evaluate(
    (key) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("keyval-store");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction("keyval").objectStore("keyval").get(key);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        };
      }),
    key,
  );
const index = async (pg = p) => (await idb(pg, "dt:index")) ?? [];
const folderRecs = async (pg = p) => (await idb(pg, "dt:folders"))?.folders ?? [];
const entry = async (name, pg = p) => (await index(pg)).find((f) => f.name === name);
const folderId = async (name, pg = p) => (await folderRecs(pg)).find((f) => f.name === name)?.id;

const toastText = (pg = p) => pg.locator("[role=status] .toast").innerText({ timeout: 3000 }).catch(() => "");
const dash = async (pg, hash = "#/") => {
  await pg.goto(URL + "/" + hash);
  await pg.waitForSelector(".files");
  await pg.waitForSelector(".dash-side, .loc-btn");
  await sleep(300);
};
const go = async (pg, hash) => {
  await pg.evaluate((h) => (location.hash = h), hash);
  await sleep(350);
};
const tree = (pg = p) => pg.locator('[role=tree][aria-labelledby="projects-h"]');
const row = (name, pg = p) => tree(pg).getByRole("treeitem", { name, exact: true });
const exact = (name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const card = (name, pg = p) => pg.locator(".file-card", { has: pg.locator(".n", { hasText: exact(name) }) });
const fcard = (name, pg = p) => pg.locator(".folder-card", { has: pg.locator(".n", { hasText: exact(name) }) });
const nameIt = async (text, pg = p) => {
  await pg.keyboard.press("Control+a");
  await pg.keyboard.type(text);
  await pg.keyboard.press("Enter");
  await sleep(350);
};
const cardMenu = async (c, item, pg = p) => {
  await c.hover();
  await c.locator(".more").click();
  await pg.locator(`.menu [role=menuitem]:has-text("${item}")`).first().click();
  await sleep(300);
};
const newProject = async (name, pg = p) => {
  await pg.locator('button[aria-label="New project"]').click();
  await pg.waitForSelector('input[aria-label="Folder name"]');
  await nameIt(name, pg);
};
const newFolderHere = async (name, pg = p) => {
  await pg.locator(".files-head button:has-text('New folder')").click();
  await pg.waitForSelector('input[aria-label="Folder name"]');
  await nameIt(name, pg);
};
const newMenu = async (item, pg = p) => {
  await pg.locator(".files-head button:has-text('New')").last().click();
  await pg.locator(`.menu [role=menuitem]:has-text("${item}")`).first().click();
};
const waitSaved = async (pg = p) => {
  for (let i = 0; i < 40; i++) {
    if (/Saved locally/.test((await pg.locator(".save-state").innerText().catch(() => "")) || "")) return true;
    await sleep(250);
  }
  return false;
};
const addBox = (pg = p, name = "Box") =>
  pg.evaluate((name) => window.__dt.tool("create_nodes", { nodes: [{ type: "frame", name, x: 0, y: 0, width: 100, height: 80 }] }), name);
const locTitle = (pg = p) => pg.locator(".file-loc").getAttribute("title");
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};

try {
  // 1. A legacy entry (no folder) shows in All files and in Drafts.
  await dash(p);
  await p.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("keyval-store");
        open.onupgradeneeded = () => open.result.createObjectStore("keyval");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const os = open.result.transaction("keyval", "readwrite");
          os.objectStore("keyval").put([{ id: "flegacyold", name: "Legacy One", updatedAt: 1000 }], "dt:index");
          os.oncomplete = () => resolve();
        };
      }),
  );
  await p.reload();
  await p.waitForSelector(".files");
  await p.waitForSelector(".file-card .more");
  check("a legacy file shows in All files", (await card("Legacy One").count()) === 1);
  check("...with its location line", /in Drafts/.test((await card("Legacy One").innerText()) ?? ""));
  await go(p, "#/drafts");
  check("...and in Drafts", (await card("Legacy One").count()) === 1);
  check("Drafts has no folder cards", (await p.locator(".folder-card").count()) === 0);
  check("the sidebar has the empty-state button", (await p.locator("button:has-text('Create a project')").count()) === 1);

  // 2. Project, folder, sub-folder: levels and hashes.
  await newProject("Acme");
  check("a project is created and named in place", (await row("Acme").count()) === 1 && (await folderId("Acme")) !== undefined);
  await row("Acme").click();
  await sleep(300);
  const acmeId = await folderId("Acme");
  check("opening it sets the hash", (await p.evaluate(() => location.hash)) === `#/folder/${acmeId}`);
  check("the empty folder says so", /This folder is empty/.test(await p.locator(".empty-note").innerText()));
  await newFolderHere("Marketing");
  await fcard("Marketing").locator(".folder-open").click();
  await sleep(300);
  await newFolderHere("Q4");
  await fcard("Q4").locator(".folder-open").click();
  await sleep(300);
  const mktId = await folderId("Marketing");
  const q4Id = await folderId("Q4");
  const lv = async (n) => Number(await row(n).getAttribute("aria-level"));
  check("the tree shows levels 1, 2 and 3", (await lv("Acme")) === 1 && (await lv("Marketing")) === 2 && (await lv("Q4")) === 3, `${await lv("Acme")}${await lv("Marketing")}${await lv("Q4")}`);
  check("the current folder is aria-current", (await row("Q4").getAttribute("aria-current")) === "page");
  check("the breadcrumb lists the path", (await p.locator('nav[aria-label="Location"]').innerText()).replace(/\s+/g, " ").includes("Acme Marketing Q4"));
  check("the hash is the folder", (await p.evaluate(() => location.hash)) === `#/folder/${q4Id}`);

  // 3. A new file in Q4 keeps its folder through saves, rename and reload.
  await newMenu("New design file");
  await p.waitForSelector("#dt-canvas");
  await p.waitForSelector(".file-loc");
  await sleep(500);
  check("the top bar shows the location", (await locTitle()) === "Acme / Marketing / Q4", String(await locTitle()));
  check("the file's index entry has the folder", (await entry("Untitled"))?.folder === q4Id);
  await addBox();
  check("it saves", await waitSaved());
  check("an autosave keeps the folder", (await entry("Untitled"))?.folder === q4Id);
  await p.fill(".filename", "Launch deck");
  await p.keyboard.press("Enter");
  await sleep(300);
  await addBox(p, "Box 2");
  check("it saves again", await waitSaved());
  check("a rename keeps the folder", (await entry("Launch deck"))?.folder === q4Id, JSON.stringify(await entry("Launch deck")));
  await p.reload();
  await p.waitForSelector("#dt-canvas");
  await p.waitForSelector(".file-loc");
  await sleep(500);
  await addBox(p, "Box 3");
  await waitSaved();
  check("after a reload and another save it is still in Q4", (await entry("Launch deck"))?.folder === q4Id && (await locTitle()) === "Acme / Marketing / Q4");
  await go(p, "#/drafts");
  check("it is not in Drafts", (await card("Launch deck").count()) === 0);
  await go(p, `#/folder/${q4Id}`);
  check("it is in Q4", (await card("Launch deck").count()) === 1);

  // 4. Duplicate, Open .dtron and a template all land in Q4.
  await cardMenu(card("Launch deck"), "Duplicate");
  await waitFor(async () => (await card("Launch deck (copy)").count()) === 1);
  check("Duplicate stays in Q4", (await card("Launch deck (copy)").count()) === 1 && (await entry("Launch deck (copy)"))?.folder === q4Id, JSON.stringify([(await card("Launch deck (copy)").count()), (await index()).map((f) => f.name + ":" + f.folder)]));
  // A document to import: the saved one, read back from storage.
  const launchId = (await entry("Launch deck")).id;
  const stored = await idb(p, "dt:file:" + launchId);
  check("(the saved file is stored in layers)", stored?.v === 2);
  // A real engine document: take it from the open editor.
  await p.evaluate((h) => (location.hash = h), `#/file/${launchId}`);
  await p.waitForSelector("#dt-canvas");
  await sleep(600);
  const realDoc = await p.evaluate(() => JSON.stringify({ ...window.__dt.doc(), name: "Imported thing" }));
  await go(p, `#/folder/${q4Id}`);
  const [fc] = await Promise.all([p.waitForEvent("filechooser"), newMenu("Open .dtron")]);
  await fc.setFiles({ name: "imp.dtron", mimeType: "application/json", buffer: Buffer.from(realDoc) });
  await p.waitForSelector("#dt-canvas");
  await sleep(500);
  check("Open .dtron lands in Q4", (await entry("Imported thing"))?.folder === q4Id && (await locTitle()) === "Acme / Marketing / Q4");
  await go(p, `#/folder/${q4Id}`);
  await newMenu("template");
  await p.waitForSelector("#dt-canvas");
  await sleep(500);
  const known = ["Launch deck", "Launch deck (copy)", "Imported thing"];
  const fromTemplate = (await index()).filter((f) => f.folder === q4Id && !known.includes(f.name));
  check("a template lands in Q4", fromTemplate.length === 1, JSON.stringify(fromTemplate.map((f) => f.name)));
  await go(p, `#/folder/${q4Id}`);
  check("Q4 has four files", (await p.locator(".file-card").count()) === 4, String(await p.locator(".file-card").count()));

  // 5. Move to… by keyboard; cycle refusal; a folder to another project.
  await newProject("Beta");
  const betaId = await folderId("Beta");
  await go(p, `#/folder/${q4Id}`);
  const tgt = "Launch deck (copy)";
  await p.locator(`button[aria-label="More actions for ${tgt}"]`).focus();
  await p.keyboard.press("Enter");
  await sleep(200);
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown");
  const onMove = await p.evaluate(() => document.activeElement?.textContent ?? "");
  await p.keyboard.press("Enter");
  await p.waitForSelector(".move-dialog");
  check("Move to… opens from the keyboard", /Move to/.test(onMove) && (await p.locator(".move-dialog").count()) === 1, onMove);
  check("Move is off until the choice changes", await p.locator(".move-dialog button.primary").isDisabled());
  await p.keyboard.press("Tab");
  const inTree = await p.evaluate(() => !!document.activeElement?.closest("[role=tree]"));
  await p.keyboard.press("Home");
  await sleep(100);
  await p.keyboard.press("Enter");
  check("the picker is keyboard operable", inTree && (await p.locator(".move-dialog button.primary").isEnabled()));
  await p.locator(".move-dialog button.primary").focus();
  await p.keyboard.press("Enter");
  await sleep(500);
  check("the file moved to Drafts", (await entry(tgt))?.folder === undefined && /Moved “Launch deck \(copy\)” to Drafts/.test(await toastText()), await toastText());
  check("it left Q4", (await card(tgt).count()) === 0);

  await go(p, `#/folder/${acmeId}`);
  await cardMenu(fcard("Marketing"), "Move to");
  await p.waitForSelector(".move-dialog");
  const dis = (n) => p.locator(".move-dialog").getByRole("treeitem", { name: n, exact: true }).getAttribute("aria-disabled");
  check("Marketing, and Q4 inside it, are disabled targets", (await dis("Marketing")) === "true" && (await dis("Q4")) === "true");
  check("Acme and Beta are not", (await dis("Beta")) === null);
  await p.locator(".move-dialog").getByRole("treeitem", { name: "Q4", exact: true }).click({ force: true });
  check("clicking a disabled target keeps Move off", await p.locator(".move-dialog button.primary").isDisabled());
  await p.locator(".move-dialog").getByRole("treeitem", { name: "Beta", exact: true }).click();
  await p.locator(".move-dialog button.primary").click();
  await sleep(500);
  const recs = await folderRecs();
  check("Marketing moved under Beta", recs.find((f) => f.id === mktId)?.parent === betaId);
  check("Q4 went with it", recs.find((f) => f.id === q4Id)?.parent === mktId);
  await go(p, `#/folder/${q4Id}`);
  check("the top path follows", (await row("Q4").getAttribute("aria-level")) === "3" && (await p.locator('nav[aria-label="Location"]').innerText()).replace(/\s+/g, " ").includes("Beta Marketing Q4"));

  // 6. Drag and drop: a file onto a tree row, a file onto a folder card.
  await go(p, "#/drafts");
  await p.dragAndDrop(`.file-card:has(.n:text-is("${tgt}"))`, '[role=tree][aria-labelledby="projects-h"] [role=treeitem][aria-label="Beta"]');
  await sleep(500);
  check("a file card dropped on a tree row moves there", (await entry(tgt))?.folder === betaId, JSON.stringify(await entry(tgt)));
  await go(p, `#/folder/${betaId}`);
  await p.dragAndDrop(`.file-card:has(.n:text-is("${tgt}"))`, '.folder-card:has(.n:text-is("Marketing"))');
  await sleep(500);
  check("a file card dropped on a folder card moves there", (await entry(tgt))?.folder === mktId);
  await go(p, `#/folder/${betaId}`);
  // A folder can't be dropped into itself or its own child.
  await p.dragAndDrop('.folder-card:has(.n:text-is("Marketing"))', '[role=tree][aria-labelledby="projects-h"] [role=treeitem][aria-label="Q4"]').catch(() => {});
  await sleep(400);
  check("a folder dropped into its own child is refused", (await folderRecs()).find((f) => f.id === mktId)?.parent === betaId);

  // 7. Search from Drafts finds the file with its location.
  await go(p, "#/drafts");
  await p.fill('input[aria-label="Search files and folders"]', "deck (copy)");
  await sleep(300);
  check("search finds files in other folders", (await card(tgt).count()) === 1);
  check("...with the location line", /in Beta \/ Marketing/.test(await card(tgt).innerText()), await card(tgt).innerText());
  await p.fill('input[aria-label="Search files and folders"]', "market");
  await sleep(250);
  check("search finds folders too", (await fcard("Marketing").count()) === 1);
  await p.fill('input[aria-label="Search files and folders"]', "zzzz");
  await sleep(250);
  check("no matches says so", /No files match “zzzz”/.test(await p.locator(".empty-note").innerText()));
  await p.locator('input[aria-label="Search files and folders"]').press("Escape");
  await sleep(200);
  check("Escape clears the search", (await p.inputValue('input[aria-label="Search files and folders"]')) === "");

  // 8. Delete Marketing: the dialog counts, Escape cancels, confirming sends files to Drafts.
  await go(p, `#/folder/${betaId}`);
  const inMkt = (await index()).filter((f) => [mktId, q4Id].includes(f.folder)).length;
  await cardMenu(fcard("Marketing"), "Delete");
  const dlg = p.locator('[role=alertdialog]');
  await dlg.waitFor();
  const msg = await dlg.innerText();
  check("the dialog says what will happen", msg.includes("Delete “Marketing” and 1 folder inside?") && msg.includes(`${inMkt} files will move to Drafts`), msg.replace(/\s+/g, " "));
  await p.keyboard.press("Escape");
  await sleep(300);
  check("Escape cancels", (await dlg.count()) === 0 && (await folderId("Marketing")) !== undefined);
  await cardMenu(fcard("Marketing"), "Delete");
  await dlg.waitFor();
  await dlg.getByRole("button", { name: "Delete" }).click();
  await sleep(600);
  check("confirming removes the folders", (await folderId("Marketing")) === undefined && (await folderId("Q4")) === undefined);
  check("...and every file inside is in Drafts", (await index()).filter((f) => f.folder === mktId || f.folder === q4Id).length === 0 && (await index()).length >= inMkt + 1);
  check("...with a toast", /moved to Drafts/.test(await toastText()), await toastText());
  await go(p, "#/drafts");
  check("the files show in Drafts", (await card("Launch deck").count()) === 1 && (await card("Imported thing").count()) === 1);
  // Deleting a file uses the in-page dialog.
  await cardMenu(card("Imported thing"), "Delete");
  await dlg.waitFor();
  check("a file delete says it cannot be undone", /Delete “Imported thing”\? This cannot be undone\./.test(await dlg.innerText()));
  await dlg.getByRole("button", { name: "Delete" }).click();
  await sleep(500);
  check("it is deleted", (await entry("Imported thing")) === undefined && (await card("Imported thing").count()) === 0);
  // Rename is inline too.
  await cardMenu(card("Launch deck"), "Rename");
  await p.waitForSelector('input[aria-label="File name"]');
  await nameIt("Launch deck v2");
  check("a file renames inline", (await entry("Launch deck v2")) !== undefined);
  check("no browser dialog was used", dialogs.length === 0, dialogs.join(","));

  // 9. Two tabs.
  const b = track(await context.newPage());
  await dash(b, "#/");
  await newProject("Shared");
  const sharedId = await folderId("Shared");
  check("a folder made in tab A shows in tab B within 2 s", await waitFor(async () => (await row("Shared", b).count()) === 1, 2000));
  const c = track(await context.newPage());
  const xId = (await entry("Launch deck v2")).id;
  await c.goto(`${URL}/#/file/${xId}`);
  await c.waitForSelector("#dt-canvas");
  await c.waitForSelector(".file-loc");
  await sleep(600);
  check("tab C has the file open from Drafts", (await locTitle(c)) === "Drafts");
  await go(p, "#/drafts");
  await cardMenu(card("Launch deck v2"), "Move to");
  await p.waitForSelector(".move-dialog");
  await p.locator(".move-dialog").getByRole("treeitem", { name: "Shared", exact: true }).click();
  await p.locator(".move-dialog button.primary").click();
  await sleep(600);
  check("the move is stored", (await entry("Launch deck v2"))?.folder === sharedId);
  check("tab C's breadcrumb updates live", await waitFor(async () => (await locTitle(c)) === "Shared", 2500), String(await locTitle(c)));
  check("tab C is not marked stale", (await c.locator(".stale-bar").count()) === 0);
  await addBox(c, "From C");
  check("tab C saves", await waitSaved(c));
  check("tab C's autosave keeps the new folder", (await entry("Launch deck v2"))?.folder === sharedId);
  check("tab B (on All files) lists the file under Shared after C's save", await waitFor(async () => /in Shared/.test((await card("Launch deck v2", b).innerText().catch(() => "")) || ""), 2500));
  await c.close();
  await b.close();

  // 10. Tree keyboard.
  await go(p, "#/");
  await newProject("Keys");
  const keysId = await folderId("Keys");
  await go(p, `#/folder/${keysId}`);
  await newFolderHere("Child");
  await sleep(300);
  const focusedLabel = () => p.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  await row("Keys").focus();
  check("the tree is one Tab stop", (await p.locator('[role=tree][aria-labelledby="projects-h"] [role=treeitem][tabindex="0"]').count()) === 1);
  check("the parent is expanded and Child is a level 2 row", (await row("Child").count()) === 1 && (await row("Keys").getAttribute("aria-expanded")) === "true");
  await p.keyboard.press("ArrowLeft");
  await sleep(150);
  check("Left collapses", (await row("Child").count()) === 0 && (await row("Keys").getAttribute("aria-expanded")) === "false");
  await p.keyboard.press("ArrowRight");
  await sleep(150);
  check("Right expands", (await row("Child").count()) === 1);
  await p.keyboard.press("ArrowRight");
  await sleep(150);
  check("Right again goes to the first child", (await focusedLabel()) === "Child", String(await focusedLabel()));
  await p.keyboard.press("ArrowLeft");
  await sleep(150);
  check("Left on a child goes to its parent", (await focusedLabel()) === "Keys");
  await p.keyboard.press("ArrowUp");
  await sleep(100);
  check("Up moves to the previous row", (await focusedLabel()) === "Beta", String(await focusedLabel()));
  await p.keyboard.press("End");
  await sleep(100);
  const last = await focusedLabel();
  await p.keyboard.press("Home");
  await sleep(100);
  check("Home and End jump to the ends", (await focusedLabel()) === "Acme" && !!last && last !== "Acme", String(last));
  await row("Keys").focus();
  await p.keyboard.press("F2");
  await p.waitForSelector('input[aria-label="Folder name"]');
  await nameIt("Keys 2");
  check("F2 renames in place", (await folderId("Keys 2")) === keysId);
  check("focus returns to the row after renaming", (await focusedLabel()) === "Keys 2", String(await focusedLabel()));
  await row("Beta").focus();
  await p.keyboard.press("Enter");
  await sleep(300);
  check("Enter navigates", (await p.evaluate(() => location.hash)) === `#/folder/${betaId}`);
  check("All files and Drafts are plain links above the Projects heading", (await p.locator(".side-links a").count()) === 2 && (await p.locator('.side-links [role=treeitem]').count()) === 0 && (await p.locator("#projects-h").innerText()) === "Projects");
  await row("Keys 2").focus();
  await p.keyboard.press("Delete");
  await dlg.waitFor();
  check("Delete opens the confirm dialog", /Delete “Keys 2” and 1 folder inside/.test(await dlg.innerText()));
  await p.keyboard.press("Escape");
  await sleep(300);
  check("Escape closes it and nothing is deleted", (await dlg.count()) === 0 && (await folderId("Keys 2")) !== undefined);
  // The project you are in can be collapsed (its parents are only opened on arrival).
  const childId = await folderId("Child");
  await go(p, `#/folder/${childId}`);
  check("arriving in Child shows Keys 2 open", (await row("Child").count()) === 1);
  await row("Keys 2").focus();
  await p.keyboard.press("ArrowLeft");
  await sleep(200);
  check("a parent of the current folder collapses", (await row("Child").count()) === 0 && (await row("Keys 2").getAttribute("aria-expanded")) === "false");
  await p.keyboard.press("ArrowRight");
  await sleep(150);
  // A subfolder's New folder from its card goes there and shows the name field.
  await go(p, `#/folder/${keysId}`);
  await cardMenu(fcard("Child"), "New folder");
  await p.waitForSelector('input[aria-label="Folder name"]');
  check("New folder from a card menu opens its parent with the name field", (await p.evaluate(() => location.hash)) === `#/folder/${childId}`);
  await p.keyboard.press("Control+a");
  await p.keyboard.press("Backspace");
  await p.keyboard.press("Enter");
  await sleep(300);
  check("a blank name is refused and the field stays", (await p.locator('input[aria-label="Folder name"]').count()) === 1 && /needs a name/.test(await toastText()), await toastText());
  await nameIt("Grandchild");
  check("then the name is applied", (await folderId("Grandchild")) !== undefined);
  await go(p, "#/");
  await newProject("Temp A");
  await newProject("Temp B");

  // 11. Phone.
  const ph = track(await context.newPage());
  await ph.setViewportSize({ width: 390, height: 844 });
  await dash(ph, "#/drafts");
  check("the sidebar is hidden on a phone", (await ph.locator(".dash-side").count()) === 0);
  const noScroll = await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector(".files").scrollWidth <= window.innerWidth + 1);
  check("no horizontal scroll", noScroll);
  const locBtn = ph.locator(".loc-btn");
  check("a location button names the place", /Drafts/.test(await locBtn.innerText()));
  await locBtn.click();
  await ph.waitForSelector('[role=dialog][aria-label="Locations"]');
  check("the sheet shows the tree", (await ph.locator('[role=dialog] [role=treeitem][aria-label="Shared"]').count()) === 1);
  if (SHOTS) await ph.screenshot({ path: `${SHOTS}/dashboard-phone-sheet.png` });
  await ph.locator('[role=dialog] [role=treeitem][aria-label="Shared"]').click();
  await sleep(500);
  check("picking a location closes the sheet and goes there", (await ph.locator("[role=dialog]").count()) === 0 && (await ph.evaluate(() => location.hash)) === `#/folder/${sharedId}`);
  check("the button now names it", /Shared/.test(await ph.locator(".loc-btn").innerText()));
  // Folder actions from the sheet open their dialog above it.
  await ph.locator(".loc-btn").click();
  await ph.waitForSelector('[role=dialog][aria-label="Locations"]');
  await ph.locator('button[aria-label="Sidebar actions for Temp A"]').click();
  await ph.locator('.menu [role=menuitem]:has-text("Delete")').click();
  await ph.waitForSelector("[role=alertdialog]");
  check("Delete from the sheet opens the dialog with the sheet closed", (await ph.locator('[aria-label="Locations"]').count()) === 0);
  await ph.locator('[role=alertdialog] button:has-text("Delete")').click();
  await sleep(500);
  check("...and deletes the folder", (await folderId("Temp A")) === undefined && (await folderId("Temp B")) !== undefined);
  await ph.locator(".loc-btn").click();
  await ph.waitForSelector('[role=dialog][aria-label="Locations"]');
  await ph.locator('button[aria-label="Sidebar actions for Temp B"]').click();
  await ph.locator('.menu [role=menuitem]:has-text("Move to")').click();
  await ph.waitForSelector(".move-dialog");
  check("Move to… from the sheet opens the picker with the sheet closed", (await ph.locator('[aria-label="Locations"]').count()) === 0);
  await ph.locator(".move-dialog").getByRole("treeitem", { name: "Beta", exact: true }).click();
  await ph.locator(".move-dialog button.primary").click();
  await sleep(500);
  check("...and moves the folder", (await folderRecs()).find((f) => f.name === "Temp B")?.parent === betaId);
  // Escape while renaming in the sheet leaves nothing behind.
  await ph.locator(".loc-btn").click();
  await ph.waitForSelector('[role=dialog][aria-label="Locations"]');
  await ph.locator('button[aria-label="New project"]').click();
  await ph.waitForSelector('input[aria-label="Folder name"]');
  await ph.keyboard.press("Escape");
  await sleep(300);
  check("Escape in the sheet closes it and leaves no name field", (await ph.locator('input[aria-label="Folder name"]').count()) === 0 && (await ph.locator("[role=dialog]").count()) === 0);
  await go(ph, "#/drafts");
  const moveName = "Launch deck (copy)";
  await cardMenu(card(moveName, ph), "Move to", ph);
  await ph.waitForSelector(".move-dialog");
  await ph.locator(".move-dialog").getByRole("treeitem", { name: "Keys 2", exact: true }).click();
  await ph.locator(".move-dialog button.primary").click();
  await sleep(500);
  check("Move to… moves a file on a phone", (await entry(moveName))?.folder === keysId);
  await ph.close();

  // 12. A copy link lands in Drafts.
  const d = track(await context.newPage());
  await d.goto(`${URL}/#/file/${(await entry("Launch deck v2")).id}`);
  await d.waitForSelector("#dt-canvas");
  await sleep(600);
  const link = await d.evaluate(async () => {
    const doc = window.__dt.doc();
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, doc: { ...doc, name: "From a link" }, assets: {} }));
    const z = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    let s = "";
    for (const c of z) s += String.fromCharCode(c);
    return "#/copy/" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  });
  await d.evaluate((l) => (location.hash = l), link);
  await d.waitForFunction(() => /^#\/file\//.test(location.hash), null, { timeout: 8000 });
  await sleep(600);
  check("a copy link opens a new file in Drafts", (await entry("From a link"))?.folder === undefined && (await entry("From a link")) !== undefined && (await locTitle(d)) === "Drafts");
  await d.close();

  // 13. A file deleted in one tab isn't brought back by an editor that has it open.
  const victim = await entry(moveName);
  const e = track(await context.newPage());
  await e.goto(`${URL}/#/file/${victim.id}`);
  await e.waitForSelector("#dt-canvas");
  await e.waitForSelector(".file-loc");
  await sleep(600);
  await go(p, `#/folder/${keysId}`);
  await cardMenu(card(moveName), "Delete");
  await dlg.waitFor();
  await dlg.getByRole("button", { name: "Delete" }).click();
  await sleep(500);
  check("the file is deleted", (await entry(moveName)) === undefined);
  check("the open editor says so", await waitFor(async () => (await e.locator(".stale-bar:has-text('deleted in another tab')").count()) === 1, 2500));
  check("...with Keep it and Back to files", (await e.locator(".stale-bar button").allInnerTexts()).join("|") === "Keep it|Back to files");
  await addBox(e, "After delete");
  await sleep(3500);
  check("its autosave does not bring the file back", (await entry(moveName)) === undefined && (await index()).every((f) => f.id !== victim.id));
  await e.locator(".stale-bar button:has-text('Keep it')").click();
  await sleep(1500);
  check("Keep it restores it in its old folder", (await entry(moveName))?.folder === keysId, JSON.stringify(await entry(moveName)));
  check("...and the bar goes", (await e.locator(".stale-bar").count()) === 0);
  await e.reload();
  await e.waitForSelector("#dt-canvas");
  await sleep(800);
  check("the whole document came back, edits included", await e.evaluate(() => Object.values(window.__dt.doc().nodes).some((n) => n.name === "After delete")));
  // The save-error path: the entry vanishes with no broadcast (a missed message).
  await p.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("keyval-store");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("keyval", "readwrite");
          const os = tx.objectStore("keyval");
          const get = os.get("dt:index");
          get.onsuccess = () => os.put(get.result.filter((f) => f.id !== id), "dt:index");
          tx.oncomplete = () => resolve();
        };
      }),
    victim.id,
  );
  await addBox(e, "Edit two");
  check("a save finding the entry gone shows the bar", await waitFor(async () => (await e.locator(".stale-bar:has-text('deleted in another tab')").count()) === 1, 6000));
  await sleep(1500);
  check("...and does not recreate the entry", (await entry(moveName)) === undefined);
  await e.locator(".stale-bar button:has-text('Keep it')").click();
  await sleep(1500);
  check("Keep it restores it into its old folder", (await entry(moveName))?.folder === keysId, JSON.stringify(await entry(moveName)));
  await e.close();

  // Screenshots (optional).
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await go(p, "#/");
    await p.evaluate(() => document.querySelector(".files")?.scrollTo(0, 0));
    await p.screenshot({ path: `${SHOTS}/dashboard-desktop.png` });
    await go(p, `#/folder/${betaId}`);
    await go(p, `#/folder/${sharedId}`);
    await p.screenshot({ path: `${SHOTS}/dashboard-folder.png` });
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("script ran to the end", false, String(e?.stack ?? e));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
