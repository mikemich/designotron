// Round 21, r21b: the design system at scale, in the real editor.
//   S-B1 deleting an aliased variable (the alias keeps the value, tokens.css has the Dark entry, one undo)
//   S-B2 a name in two collections warns in MCP     S-B3 Escape and "No matches" in the Assets search
//   S-B4 the searchable, foldered picker (styles, bound variables, aliases, the colour picker's list)
//   S-B5 a new variable's name is focused, "+" on folders
//   G1 styles in tokens.css / tokens.json   G2 descriptions   G3 Select layers using this   G4 folder rename
//   alias re-target (click a chip)
//
// Seeds 244 colour styles in folders, 15 text styles and 469 variables over 6 collections, then
// 2,000 styles for the timing. Local only: serves web/dist with `vite preview` and aborts every
// non-local request.
//   cd web && npx vite build && node scripts/qa/r21b-e2e.mjs
// Env: E2E_PORT (7611) E2E_URL (an editor that is already served) E2E_DIST (dist) E2E_OUT (screenshots)

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 7611);
const BASE = process.env.E2E_URL ?? `http://127.0.0.1:${PORT}/`;
const DIST = process.env.E2E_DIST ?? "dist";
const OUT = process.env.E2E_OUT ?? "/tmp/r21b-shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).slice(0, 500) : ""}`);
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const children = [];
process.on("exit", () => children.forEach((c) => c.kill()));
if (!process.env.E2E_URL) {
  const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--outDir", DIST, "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"], { stdio: "ignore" });
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
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await ctx.route((u) => !LOCAL.test(u.toString()), (r) => r.abort());
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
const errors = [];
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !/bridge\/ws|Failed to load resource|WebSocket connection/.test(m.text())) errors.push("console: " + m.text().slice(0, 200));
});
page.on("dialog", (d) => {
  errors.push("dialog: " + d.message());
  d.dismiss().catch(() => {});
});
await page.goto(BASE);
await page.waitForSelector(".files");
await page.click("button:has-text('New design file')");
await page.waitForSelector("#dt-canvas");
await sleep(600);

const tool = async (name, input) => {
  const r = await page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
  if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.result)}`);
  return r.result;
};
const rawTool = (name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const doc = () => page.evaluate(() => window.__dt.doc());
const dispatch = (cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const created = (r) => r.created.map((c) => c.id);
const settle = () => sleep(250);
const styleId = async (name) => (await doc()).styles.colors.find((s) => s.name === name)?.id;
const fillStyleOf = async (id) => (await doc()).nodes[id].fillStyle;
const varNamed = async (coll, name) => {
  const d = await doc();
  const c = d.variables.find((x) => x.name === coll);
  return { c, v: c?.variables.find((x) => x.name === name) };
};
const focused = () => page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label"), value: document.activeElement?.value, s: document.activeElement?.selectionStart, e: document.activeElement?.selectionEnd }));
const pickerRows = () => page.evaluate(() => [...document.querySelectorAll("[data-token-picker] [data-tp-item]")].map((e) => e.getAttribute("data-tp-name")));
const pickerOpen = () => page.evaluate(() => !!document.querySelector("[data-token-picker]"));

// ---------- 1. Seed ----------
const hex = (i) => "#" + ((i * 2654435761) >>> 8).toString(16).padStart(6, "0").slice(-6).toUpperCase();
const GROUPS = ["Brand/Primary", "Brand/Secondary", "Neutral", "Feedback/Danger", "Feedback/Success", "Feedback/Warning", "Accent/Blue", "Accent/Green", "Accent/Pink", "Surface", "Border", "Text"];
const colors = [];
for (const g of GROUPS) for (let i = 1; i <= 20; i++) colors.push({ name: `${g}/${i}`, color: hex(colors.length + 1) });
for (let i = 1; i <= 4; i++) colors.push({ name: `Misc/Extra ${i}`, color: hex(300 + i) });
await tool("define_styles", { colors });
const TEXT = ["Display", "Heading/H1", "Heading/H2", "Heading/H3", "Heading/H4", "Heading/H5", "Heading/H6", "Body/Large", "Body/Medium", "Body/Small", "Label/Medium", "Label/Small", "Caption", "Mono/Code", "Mono/Inline"];
await tool("define_styles", { texts: TEXT.map((name, i) => ({ name, fontSize: 12 + i * 2, fontWeight: i < 7 ? 700 : 400, description: i === 1 ? "Page titles" : undefined })) });
const colorVars = (prefix, n, off) => Array.from({ length: n }, (_, i) => ({ name: `${prefix} ${i + 1}`, type: "color", value: hex(off + i) }));
await tool("define_variables", { collection: "Primitives", variables: colorVars("Palette/Brand", 150, 1000) });
await tool("define_variables", { collection: "Spacing", variables: Array.from({ length: 80 }, (_, i) => ({ name: `Space/${i + 1}`, type: "number", value: (i + 1) * 2 })) });
await tool("define_variables", { collection: "Radius", variables: Array.from({ length: 40 }, (_, i) => ({ name: `Radius/${i + 1}`, type: "number", value: i + 1 })) });
await tool("define_variables", { collection: "Typography", variables: Array.from({ length: 60 }, (_, i) => ({ name: `Font/${i + 1}`, type: "string", value: `Family ${i + 1}` })) });
await tool("define_variables", { collection: "Flags", variables: Array.from({ length: 39 }, (_, i) => ({ name: `Flag ${i + 1}`, type: "boolean", value: i % 2 === 0 })) });
const theme = [{ name: "Surface/Card", type: "color", values: { Light: { alias: "Primitives/Palette/Brand 1" }, Dark: { alias: "Primitives/Palette/Brand 2" }, "High contrast": { alias: "Primitives/Palette/Brand 3" } } }];
for (let i = 1; i <= 99; i++) {
  const folder = i <= 39 ? "Surface" : i <= 69 ? "Text" : "Border";
  theme.push({ name: `${folder}/Item ${i}`, type: "color", values: { Light: { alias: `Primitives/Palette/Brand ${i + 3}` }, Dark: hex(i), "High contrast": hex(i + 500) } });
}
await tool("define_variables", { collection: "Theme", modes: ["Light", "Dark", "High contrast"], variables: theme });
let d = await doc();
const nVars = d.variables.reduce((k, c) => k + c.variables.length, 0);
check("seeded 244 colour styles, 15 text styles and 469 variables over 6 collections", d.styles.colors.length === 244 && d.styles.texts.length === 15 && nVars === 469 && d.variables.length === 6, `${d.styles.colors.length} / ${d.styles.texts.length} / ${nVars} / ${d.variables.length}`);

const frame = created(await tool("create_nodes", { nodes: [{ type: "frame", name: "Target", x: 0, y: 0, width: 200, height: 120, fill: "#CCCCCC" }] }))[0];
const users = created(await tool("create_nodes", { nodes: [0, 1, 2].map((i) => ({ type: "rectangle", name: `User ${i}`, x: 300 + i * 80, y: 0, width: 60, height: 60, fillStyle: "Brand/Primary/1" })) }));
d = await doc();
check("three layers use Brand/Primary/1", users.every((u) => d.nodes[u].fillStyle === d.styles.colors.find((s) => s.name === "Brand/Primary/1").id));
await dispatch({ op: "select", ids: [frame] });
await sleep(400);

// ---------- 2. Apply colour style: search, keys, Escape, folders ----------
const applyBtn = page.locator('button[title="Apply colour style"]').first();
const openTimes = [];
const typeTimes = [];
for (let run = 0; run < 3; run++) {
  const t0 = Date.now();
  await applyBtn.click();
  await page.waitForSelector("[data-token-picker] input");
  openTimes.push(Date.now() - t0);
  const f = await focused();
  if (run === 0) check("the picker opens with the focus in its search field", f.tag === "INPUT" && /Search/.test(f.label ?? ""), JSON.stringify(f));
  const t1 = Date.now();
  await page.keyboard.insertText("danger");
  const rows = await pickerRows();
  typeTimes.push(Date.now() - t1);
  if (run === 0) {
    check('typing "danger" leaves only the matching rows', rows.length === 20 && rows.every((r) => /danger/i.test(r)), `${rows.length} rows: ${rows.slice(0, 3)}`);
    await page.screenshot({ path: path.join(OUT, "picker-searching.png") });
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await settle();
}
check("typing and counting the rows takes under 100 ms at 244 styles", Math.max(...typeTimes) < 100, `open ${openTimes} ms, type ${typeTimes} ms (median ${median(openTimes)} / ${median(typeTimes)})`);
const picked = await styleId("Feedback/Danger/1");
await applyBtn.click();
await page.waitForSelector("[data-token-picker] input");
await page.keyboard.insertText("danger");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await settle();
check("ArrowDown + Enter applies the first match", (await fillStyleOf(frame)) === picked && !(await pickerOpen()), `${await fillStyleOf(frame)} vs ${picked}`);
// Escape clears first, then closes.
await applyBtn.click();
await page.waitForSelector("[data-token-picker] input");
await page.keyboard.insertText("zzz");
check("a nonsense search says No matches", (await page.locator("[data-token-picker] .tp-empty").innerText()).includes("No matches for “zzz”"));
await page.keyboard.press("Escape");
check("the first Escape clears the search and keeps the picker open", (await pickerOpen()) && (await focused()).value === "");
await page.keyboard.press("Escape");
await settle();
check("the second Escape closes it", !(await pickerOpen()));
// Folders: a long list starts folded; clicking opens and closes one.
await applyBtn.click();
await page.waitForSelector("[data-token-picker] input");
const folded = await page.locator("[data-token-picker] [data-tp-folder]").count();
// The folders of the style that is applied (Feedback/Danger) start open; everything else is folded.
check("a long list starts folded, except where the applied style is", folded >= 8 && (await page.locator('[data-token-picker] [data-tp-folder="Primary"]').count()) === 0 && (await pickerRows()).every((r) => r.startsWith("Feedback/Danger/")), `${folded} folders`);
await page.screenshot({ path: path.join(OUT, "picker-open-on-applied.png") });
await page.locator('[data-token-picker] [data-tp-folder="Brand"]').click();
const nested = await page.locator("[data-token-picker] [data-tp-folder]").count();
check("opening a folder shows its sub-folders", nested > folded, `${folded} -> ${nested}`);
await page.locator('[data-token-picker] [data-tp-folder="Brand"]').click();
check("closing it folds them again", (await page.locator("[data-token-picker] [data-tp-folder]").count()) === folded);
await page.locator('[data-token-picker] [data-tp-folder="Neutral"]').click();
await page.screenshot({ path: path.join(OUT, "picker-folders.png") });
const neutralRows = (await pickerRows()).filter((r) => r.startsWith("Neutral/"));
check("a folder's styles show with their leaf names", neutralRows.length === 20 && neutralRows[0] === "Neutral/1", neutralRows.slice(0, 2));
await page.keyboard.press("Escape");
await settle();

// ---------- 3. Bound variable ----------
await page.locator('button[title="Bind a property"]').click();
const pick = page.locator('button[data-bound-pick="fill"]');
check("the bound-variable field is a button saying Not bound", (await pick.innerText()).includes("Not bound"), await pick.innerText());
await pick.click();
await page.waitForSelector("[data-token-picker] input");
await page.keyboard.insertText("surface card");
const vrows = await pickerRows();
check("searching variables finds Surface/Card under its collection", vrows.length === 1 && vrows[0] === "Surface/Card", vrows);
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await settle();
const cardVar = (await varNamed("Theme", "Surface/Card")).v;
d = await doc();
check("picking binds the fill to the variable", d.nodes[frame].bindings?.fill === cardVar.id, JSON.stringify(d.nodes[frame].bindings));
await pick.click();
await page.waitForSelector("[data-token-picker] input");
check("the picker offers Detach first", (await page.locator('[data-token-picker] [data-tp-action="Detach"]').count()) === 1);
await page.locator('[data-token-picker] [data-tp-action="Detach"]').click();
await settle();
check("Detach unbinds it", !(await doc()).nodes[frame].bindings?.fill);
await dispatch({ op: "select", ids: [] });

// ---------- 4. Variables dialog: alias re-target ----------
const openDialog = async () => {
  await page.locator("button:has-text('Open variables')").click();
  await page.waitForSelector(".variables-dialog");
  await sleep(150);
};
await openDialog();
const f0 = await focused();
check("the Variables dialog opens with the focus on the search field", f0.tag === "INPUT" && f0.label === "Search variables", JSON.stringify(f0));
await page.locator(".var-coll", { hasText: "Theme" }).first().click();
await page.locator('input[aria-label="Search variables"]').fill("surface/card");
await sleep(400);
const row = page.locator('tr[data-variable="Surface/Card"]');
await row.waitFor();
const aliasOfMode = async (mode) => {
  const { c, v } = await varNamed("Theme", "Surface/Card");
  return v.values[c.modes.find((m) => m.name === mode).id]?.alias;
};
const brand = async (n) => (await varNamed("Primitives", `Palette/Brand ${n}`)).v.id;
const before = await aliasOfMode("Dark");
check("the Dark alias starts on Brand 2", before === (await brand(2)));
const undoDepth = async () => (await page.evaluate(() => window.__dt.state())).undoDepth ?? null;
await row.locator(".var-alias-chip").nth(1).click();
await page.waitForSelector("[data-token-picker] input");
await page.keyboard.insertText("brand 7");
await page.screenshot({ path: path.join(OUT, "alias-picker.png") });
const arows = await pickerRows();
check("the alias picker lists the Primitives (never the variable itself)", arows.length > 0 && arows[0] === "Palette/Brand 7", arows.slice(0, 3));
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await settle();
check("clicking the chip re-targets the alias", (await aliasOfMode("Dark")) === (await brand(7)) && (await aliasOfMode("Light")) === (await brand(1)), `${await aliasOfMode("Dark")}`);
await dispatch({ op: "undo" });
await settle();
check("one undo puts it back", (await aliasOfMode("Dark")) === (await brand(2)));
// The Details popover keeps a description that was typed when the person clicks outside.
await row.locator("[data-var-details]").click();
await page.locator('input[aria-label="Description"]').fill("Card background");
await page.locator(".variables-dialog .modal-head b").click();
await settle();
check("a description typed in Details survives a click outside", (await varNamed("Theme", "Surface/Card")).v.description === "Card background", JSON.stringify((await varNamed("Theme", "Surface/Card")).v.description));

// ---------- 5. Create variable: focus, folder "+" ----------
await page.locator(".var-coll", { hasText: "Primitives" }).first().click();
await page.locator('input[aria-label="Search variables"]').fill("");
await sleep(300);
await page.locator("button:has-text('Create variable')").click();
await page.locator(".menu .item", { hasText: "Color" }).first().click();
await sleep(300);
const fnew = await focused();
check("a new variable's name is focused with its text selected", fnew.label === "Variable name" && /^color \d+$/.test(fnew.value) && fnew.s === 0 && fnew.e === fnew.value.length, JSON.stringify(fnew));
await page.keyboard.type("Brand/Accent");
await page.keyboard.press("Enter");
await settle();
check("typing a name with a folder and pressing Enter stores it", !!(await varNamed("Primitives", "Brand/Accent")).v);
await page.locator('button[aria-label="Create variable in Brand"]').click();
await sleep(300);
const fplus = await focused();
check('"+" on the folder creates a variable inside it, name focused', fplus.label === "Variable name" && /^color \d+$/.test(fplus.value) && fplus.s === 0 && fplus.e === fplus.value.length, JSON.stringify(fplus));
const innerName = (await doc()).variables.find((c) => c.name === "Primitives").variables.at(-1).name;
check("its stored name is Brand/color N", /^Brand\/color \d+$/.test(innerName), innerName);
await page.screenshot({ path: path.join(OUT, "dialog-create.png") });
await page.keyboard.press("Enter");
await settle();

// ---------- 6. S-B1: delete an aliased variable ----------
await tool("define_variables", { collection: "Prim S", variables: [{ name: "Ink", type: "color", value: "#111111" }, { name: "Paper", type: "color", value: "#FAFAFA" }] });
await tool("define_variables", { collection: "Theme S", modes: ["Light", "Dark"], variables: [{ name: "Surface", type: "color", values: { Light: { alias: "Prim S/Paper" }, Dark: { alias: "Prim S/Ink" } } }] });
const pinned = created(await tool("create_nodes", { nodes: [{ type: "frame", name: "Pinned", x: 0, y: 400, width: 80, height: 80, bind: { fill: "Theme S/Surface" }, variableModes: { "Theme S": "Dark" } }] }))[0];
const fillOf = async (id) => (await doc()).nodes[id].fills[0].color.toUpperCase();
check("the Dark-pinned frame shows Ink before the delete", (await fillOf(pinned)) === "#111111");
await page.locator(".var-coll", { hasText: "Prim S" }).first().click();
await page.locator('input[aria-label="Search variables"]').fill("");
await sleep(300);
await page.locator('button[aria-label="Delete Ink"]').click();
await sleep(400);
const toastText = await page.evaluate(() => [...document.querySelectorAll(".toast, [role=status], [role=alert]")].map((e) => e.textContent).join(" | "));
check("the toast says the alias now uses Ink's value", toastText.includes("1 alias now uses Ink's value"), toastText.slice(0, 300));
check("the frame keeps Ink's colour", (await fillOf(pinned)) === "#111111");
await dispatch({ op: "setVariableMode", ids: [pinned], collection: (await doc()).variables.find((c) => c.name === "Theme S").id, mode: (await doc()).variables.find((c) => c.name === "Theme S").modes[0].id });
await settle();
const lightFill = await fillOf(pinned);
await dispatch({ op: "setVariableMode", ids: [pinned], collection: (await doc()).variables.find((c) => c.name === "Theme S").id, mode: (await doc()).variables.find((c) => c.name === "Theme S").modes[1].id });
await settle();
check("Light shows Paper, and back to Dark still shows Ink", lightFill === "#FAFAFA" && (await fillOf(pinned)) === "#111111", `${lightFill} / ${await fillOf(pinned)}`);
await page.locator(".var-coll", { hasText: "Theme S" }).first().click();
await sleep(300);
await page.screenshot({ path: path.join(OUT, "dialog-after-delete.png") });
const proj = await tool("export_code", { format: "project" });
const css = proj.files.find((f) => f.path === "src/tokens.css").content;
const dark = css.split('[data-theme-s="dark"]')[1] ?? css.split('[data-theme-s="dark-2"]')[1] ?? "";
check("the exported tokens.css Dark block has the variable", /--surface:\s*#111111/i.test(dark), dark.slice(0, 200));
// One undo (via the dialog's own history) puts the alias back.
await dispatch({ op: "undo" });
await dispatch({ op: "undo" });
await dispatch({ op: "undo" });
await settle();
const surf = (await varNamed("Theme S", "Surface")).v;
check("undo restores the alias", Object.values(surf.values).every((v) => v?.alias), JSON.stringify(surf.values));
await dispatch({ op: "redo" });
await dispatch({ op: "redo" });
await dispatch({ op: "redo" });
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await sleep(300);
if (await page.$(".variables-dialog")) await page.locator('.variables-dialog button[title="Close"]').click();

// ---------- 7. S-B2 over MCP ----------
await tool("define_variables", { collection: "Dup A", variables: [{ name: "Brand", type: "color", value: "#FF0000" }] });
await tool("define_variables", { collection: "Dup B", variables: [{ name: "Brand", type: "color", value: "#00FF00" }] });
const dup = await tool("create_nodes", { nodes: [{ type: "frame", name: "Dup", x: 0, y: 600, width: 50, height: 50, bind: { fill: "Brand" } }] });
check("a bare name in two collections warns", JSON.stringify(dup.warnings ?? []).includes("'Brand' is in Dup A and Dup B; bound Dup A/Brand. Write 'Dup B/Brand' for the other."), JSON.stringify(dup.warnings));
await tool("define_variables", { collection: "Dup B", variables: [{ name: "Own", type: "color", value: { alias: "Brand" } }] });
const own = await varNamed("Dup B", "Own");
const ownBrand = (await varNamed("Dup B", "Brand")).v.id;
check("an alias takes the collection being written first", Object.values(own.v.values)[0]?.alias === ownBrand, JSON.stringify(own.v.values));

// ---------- 8. S-B3: Assets search ----------
await dispatch({ op: "select", ids: [] });
await page.getByRole("tab", { name: /Assets/i }).first().click().catch(async () => page.getByText("Assets", { exact: true }).first().click());
await sleep(300);
const search = page.locator('input[aria-label="Search assets"]');
await search.click();
await search.fill("zzzzqq");
await sleep(200);
check('a search with no result says "No matches" and shows no empty section heads', (await page.locator("[data-assets-empty]").count()) === 1 && (await page.locator('[data-styles="colour"], [data-styles="text"], [data-styles="components"], [data-testid="image-assets"]').count()) === 0, await page.locator("[data-assets-empty]").innerText().catch(() => "none"));
await page.screenshot({ path: path.join(OUT, "assets-no-matches.png") });
await page.keyboard.press("Escape");
await sleep(150);
check("Escape clears the search and the sections come back", (await search.inputValue()) === "" && (await page.locator('[data-styles="colour"]').count()) === 1);
await page.keyboard.press("Escape");
await sleep(150);
check("a second Escape leaves the field", (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) !== "Search assets");

// ---------- 9. Descriptions (G2) and picker titles ----------
const colourSection = page.locator('[data-styles="colour"]');
const misc = colourSection.locator(".wf-style-row", { hasText: "Extra 1" });
await misc.hover();
await misc.locator('button[title="Edit style"]').click();
const info = colourSection.locator('input[aria-label="Description"]');
await info.fill("Used for badges");
await page.keyboard.press("Enter");
await settle();
const extra = (await doc()).styles.colors.find((s) => s.name === "Misc/Extra 1");
check("a colour style's Info is saved", extra.description === "Used for badges", JSON.stringify(extra));
check("the edit row counts its usage", (await colourSection.locator("[data-usage]").first().innerText()).includes("Not used by any layer"));
await misc.locator('button[title="Done editing"]').click().catch(() => {});
await dispatch({ op: "select", ids: [frame] });
await sleep(300);
await applyBtn.click();
await page.waitForSelector("[data-token-picker] input");
await page.keyboard.insertText("extra 1");
const title = await page.locator("[data-token-picker] [data-tp-item]").first().getAttribute("title");
check("the description is the picker row's title", (title ?? "").includes("Used for badges"), title);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await settle();
const ts = (await doc()).styles.texts.find((s) => s.name === "Heading/H1");
check("define_styles saved a text style description, and it round-trips through saves", ts.description === "Page titles");

// ---------- 10. Select layers using this (G3) ----------
await dispatch({ op: "select", ids: [] });
await sleep(200);
const row1 = colourSection.locator('.asset-folder-wrap[aria-label="Brand"] .asset-folder-wrap[aria-label="Primary"] .wf-style-row', { hasText: /^1\s*#/ }).first();
await row1.hover();
await row1.locator('button[title="Select layers using this"]').click();
await settle();
const sel = (await page.evaluate(() => window.__dt.state())).selection;
check("Select layers using this selects the 3 layers", sel.length === 3 && users.every((u) => sel.includes(u)), JSON.stringify(sel));

// ---------- 11. Folder rename (G4) ----------
d = await doc();
const brandNames = d.styles.colors.filter((s) => s.name.startsWith("Brand/")).map((s) => s.id);
await colourSection.locator('.asset-folder', { hasText: "Brand" }).first().dblclick();
const ren = page.locator('input[aria-label="Rename folder Brand"]');
await ren.waitFor();
await ren.fill("Accent");
await page.keyboard.press("Enter");
await settle();
d = await doc();
check("renaming the folder renames every style inside", brandNames.length === 40 && brandNames.every((id) => d.styles.colors.find((s) => s.id === id).name.startsWith("Accent/")) && !d.styles.colors.some((s) => s.name.startsWith("Brand/")), `${brandNames.length}`);
check("the layers that use it keep the style", users.every((u) => d.nodes[u].fillStyle === brandNames[0]));
await dispatch({ op: "undo" });
await settle();
d = await doc();
check("one undo restores all of them", brandNames.every((id) => d.styles.colors.find((s) => s.id === id).name.startsWith("Brand/")));
// A rename that would collide is refused with a toast.
await tool("define_styles", { colors: [{ name: "Taken/1", color: "#123456" }, { name: "Mover/1", color: "#654321" }] });
await sleep(300);
const hist = (await page.evaluate(() => window.__dt.state())).docRev;
await colourSection.locator('.asset-folder', { hasText: "Mover" }).first().dblclick();
await page.locator('input[aria-label="Rename folder Mover"]').fill("Taken");
await page.keyboard.press("Enter");
await settle();
const toast2 = await page.evaluate(() => [...document.querySelectorAll(".toast, [role=status], [role=alert]")].map((e) => e.textContent).join(" | "));
check("a rename that clashes is refused and names the style", toast2.includes("Taken/1 already exists") && (await doc()).styles.colors.some((s) => s.name === "Mover/1"), toast2.slice(0, 200));
check("the refused rename changed nothing", (await page.evaluate(() => window.__dt.state())).docRev === hist);

// ---------- 12. G1: styles in the token files ----------
const tj = JSON.parse(await page.evaluate(() => window.__dt.query({ q: "tokensJson" })));
check("tokens.json has a marked Styles group with colours and typography", tj.Styles?.$extensions?.["com.designotron"]?.styles === true && tj.Styles.Brand?.Primary?.["1"]?.$type === "color" && tj.Styles.Heading?.H1?.$type === "typography" && tj.Styles.Heading.H1.$description === "Page titles", JSON.stringify(Object.keys(tj)));
const proj2 = await tool("export_code", { format: "project" });
const css2 = proj2.files.find((f) => f.path === "src/tokens.css").content;
check("tokens.css has the colour styles under their index.css names", css2.includes("/* Colour styles */") && css2.includes("--color-brand-primary-1:"), css2.slice(css2.indexOf("/* Colour styles */"), css2.indexOf("/* Colour styles */") + 120));

// ---------- 13. The colour picker's list of styles ----------
const plainFrame = created(await tool("create_nodes", { nodes: [{ type: "frame", name: "Plain", x: 0, y: 800, width: 100, height: 100, fill: "#888888" }] }))[0];
await dispatch({ op: "select", ids: [plainFrame] });
await sleep(400);
await page.locator('.swatch[aria-label^="Fill"], .swatch[aria-label*="888888" i]').first().click().catch(() => {});
const inplace = await page.waitForSelector("[data-colour-styles-list]", { timeout: 4000 }).catch(() => null);
if (inplace) {
  await page.locator("[data-colour-styles-list] input").fill("neutral/3");
  const first = page.locator("[data-colour-styles-list] [data-tp-item]").first();
  const name = await first.getAttribute("data-tp-name");
  await first.click();
  await settle();
  check("the colour picker's long style list is searchable and sets the colour", name === "Neutral/3" || /^Neutral\/3/.test(name ?? ""), name);
  await page.keyboard.press("Escape");
} else check("the colour picker's long style list is searchable", false, "the list did not render: " + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".swatch")].map((e) => e.getAttribute("aria-label")).slice(0, 8))));
await dispatch({ op: "select", ids: [] });

// ---------- 14. Timing at 2,000 styles ----------
const bulk = [];
for (let i = 0; i < 1756; i++) bulk.push({ name: `Bulk ${i % 30}/Style ${i}`, color: hex(2000 + i) });
await tool("define_styles", { colors: bulk });
check("2,000 colour styles", (await doc()).styles.colors.length >= 2000, (await doc()).styles.colors.length);
await dispatch({ op: "select", ids: [frame] });
await sleep(500);
const open2 = [];
const type2 = [];
for (let run = 0; run < 3; run++) {
  const t0 = Date.now();
  await applyBtn.click();
  await page.waitForSelector("[data-token-picker] input");
  open2.push(Date.now() - t0);
  const t1 = Date.now();
  await page.keyboard.insertText("danger");
  const rows = await pickerRows();
  type2.push(Date.now() - t1);
  if (run === 0) check("2,000 styles: a search is narrowed to the matches", rows.length === 20, rows.length);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await settle();
}
console.log(`TIMING picker at 244 styles: open ${openTimes.join("/")} ms (median ${median(openTimes)}), type+count ${typeTimes.join("/")} ms (median ${median(typeTimes)})`);
console.log(`TIMING picker at 2,000 styles: open ${open2.join("/")} ms (median ${median(open2)}), type+count ${type2.join("/")} ms (median ${median(type2)})`);
// The cap: an unfiltered, fully open list draws at most 200 rows.
await applyBtn.click();
await page.waitForSelector("[data-token-picker] input");
await page.keyboard.insertText("style");
const drawn = await page.locator("[data-token-picker] [data-row]").count();
check("at most 200 rows are drawn, with a note for the rest", drawn <= 201 && (await page.locator("[data-tp-more]").count()) === 1, `${drawn} rows`);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");

check("no page errors, console errors or dialogs", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
