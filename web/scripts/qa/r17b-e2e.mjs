// r17b: design-system workflow. Styles match by id on paste (a rename in the source adds nothing),
// variant property order follows the written order (names, set panel, instance pickers, Assets),
// tool-made components don't stack at the origin, the Layers search has a "Match text content"
// toggle that survives a reload, and the Variables dialog imports Designotron, W3C design tokens
// and Tokens Studio files (report, skipped list, one undo step).
// Usage: `npm run build`, then `npx vite preview --port 6911 --strictPort`, then
//   cd web && E2E_URL=http://127.0.0.1:6911/ node scripts/qa/r17b-e2e.mjs      Screenshots: SHOTS=<dir>.
// Local requests only: every other request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const URL_ = process.env.E2E_URL ?? "http://127.0.0.1:6911/";
const SHOTS = process.env.SHOTS ?? "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => fs.readFileSync(path.join(here, "..", "fixtures", n), "utf8");

const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? "  - " + String(detail).slice(0, 300) : ""}`);
}

const isLocal = (u) => {
  const x = new URL(u);
  return /^(127\.0\.0\.1|localhost)$/.test(x.hostname) || /^(data|blob):$/.test(x.protocol);
};

const browser = await chromium.launch(launch);
const errors = [];

async function context(scheme = "dark") {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(URL_).origin });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  await ctx.route("**/*", (r) => (isLocal(r.request().url()) ? r.continue() : r.abort()));
  return ctx;
}

async function openFile(ctx) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  await page.getByText("New design file").first().click();
  await page.waitForSelector("#dt-canvas", { timeout: 20000 });
  await page.waitForTimeout(700);
  return page;
}

const tool = (p, name, input) => p.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const doc = (p) => p.evaluate(() => window.__dt.doc());
const dispatch = (p, cmd) => p.evaluate((c) => window.__dt.dispatch(c), cmd);
const select = (p, ids) => dispatch(p, { op: "select", ids, mode: "replace" });
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) : Promise.resolve());
const toastText = (p) => p.locator(".toast").first().textContent({ timeout: 2500 }).catch(() => "");
const toastGone = (p) => p.waitForSelector(".toast", { state: "detached", timeout: 9000 }).catch(() => {});

const dark = await context("dark");

try {
  // ---------------------------------------------------------------- C-1: styles match by id
  const a = await openFile(dark);
  await tool(a, "define_styles", {
    colors: [{ name: "Label/Button", color: "#6D4AFF" }],
    texts: [{ name: "Label/Button", fontSize: 15, fontWeight: 600 }],
    effects: [{ name: "Card", shadow: { y: 4, blur: 12 } }],
  });
  const made = await tool(a, "create_nodes", {
    nodes: [
      {
        type: "frame", name: "Screen", x: 0, y: 0, width: 320, height: 200,
        children: [
          { type: "rectangle", name: "Chip", x: 20, y: 20, width: 80, height: 40, fillStyle: "Label/Button", effectStyle: "Card" },
          { type: "text", name: "Label", text: "Buy", x: 20, y: 90, textStyle: "Label/Button" },
        ],
      },
    ],
  });
  const screenId = made.result.created[0].id;
  const clip1 = await a.evaluate((id) => window.__dt.query({ q: "copy", ids: [id] }), screenId);

  const b = await openFile(dark);
  const paste = async (clip, y) => {
    await b.evaluate((t) => navigator.clipboard.writeText(t), clip);
    await b.bringToFront();
    await b.evaluate(() => document.activeElement?.blur());
    await b.locator("#dt-canvas").click({ position: { x: 700, y } });
    await b.keyboard.press("Control+V");
    await b.waitForTimeout(700);
  };
  await paste(clip1, 650);
  const t1 = await toastText(b);
  let db = await doc(b);
  check("first paste adds the styles", /Added .*3 styles/.test(t1) && db.styles.colors.length === 1 && db.styles.texts.length === 1 && db.styles.effects.length === 1, t1);
  const bColor = db.styles.colors[0].id;
  const bText = db.styles.texts[0].id;
  await toastGone(b);

  // Rename the text style and the colour style in the design-system file, then copy again.
  const da = await doc(a);
  await dispatch(a, { op: "updateTextStyle", id: da.styles.texts[0].id, name: "Label/Button Large" });
  await dispatch(a, { op: "updateColorStyle", id: da.styles.colors[0].id, name: "Brand/Primary" });
  const renamed = await doc(a);
  check("the source's styles are renamed", renamed.styles.texts[0].name === "Label/Button Large" && renamed.styles.colors[0].name === "Brand/Primary");
  const clip2 = await a.evaluate((id) => window.__dt.query({ q: "copy", ids: [id] }), screenId);
  await paste(clip2, 560);
  const t2 = await toastText(b);
  db = await doc(b);
  check("re-pasting after a rename adds no second style", db.styles.colors.length === 1 && db.styles.texts.length === 1 && db.styles.effects.length === 1, JSON.stringify([db.styles.colors.length, db.styles.texts.length, db.styles.effects.length]));
  check("the toast doesn't say a style was added", !/style/i.test(t2) || !/Added/.test(t2), t2);
  check("the destination keeps its own names", db.styles.texts[0].name === "Label/Button" && db.styles.colors[0].name === "Label/Button", JSON.stringify([db.styles.texts[0].name, db.styles.colors[0].name]));
  const labels = Object.values(db.nodes).filter((n) => n.name === "Label" && n.type === "text");
  const chips = Object.values(db.nodes).filter((n) => n.name === "Chip");
  check("both pasted copies link to the destination's styles", labels.length === 2 && labels.every((n) => n.textStyle === bText) && chips.every((n) => n.fillStyle === bColor), JSON.stringify(labels.map((n) => n.textStyle)));
  await a.close();
  await b.close();

  // ------------------------------------------------ C-2 and C-3: variant order and placement
  const c = await openFile(dark);
  const mk = (name) => ({ type: "component", name, width: 120, height: 40, fill: "#7C5CFF", children: [{ type: "text", name: "Label", text: "Go", fill: "#FFFFFF" }] });
  const names = ["Size=S, State=Default, Icon=None", "Size=M, State=Hover, Icon=None", "Size=L, State=Default, Icon=Left"];
  const ids = [];
  for (const n of names) {
    const r = await tool(c, "create_nodes", { nodes: [mk(n)] });
    ids.push(r.result.created[0].id);
  }
  // Two more components, no positions either (five in all).
  for (const n of ["Other/One", "Other/Two"]) await tool(c, "create_nodes", { nodes: [mk(n)] });
  let dc = await doc(c);
  const boxes = Object.values(dc.nodes).filter((n) => n.type === "component" && !n.parent).map((n) => [n.x, n.y, n.x + n.width, n.y + n.height]);
  const disjoint = boxes.every((p, i) => boxes.slice(i + 1).every((q) => p[2] <= q[0] || q[2] <= p[0] || p[3] <= q[1] || q[3] <= p[1]));
  check("five tool-made components without positions have disjoint bounds", boxes.length === 5 && disjoint, JSON.stringify(boxes));
  check("the first one sits at the origin", boxes.some((p) => p[0] === 0 && p[1] === 0));
  await dispatch(c, { op: "select", ids: Object.values(dc.nodes).filter((n) => n.type === "component").map((n) => n.id), mode: "replace" });
  await c.evaluate(() => window.__dt.zoomToFit());
  await c.waitForTimeout(500);
  await shot(c, "c3-five-components");

  const combined = await tool(c, "arrange", { action: "combine_variants", ids });
  const setId = combined.result?.id ?? combined.result?.created?.[0]?.id;
  dc = await doc(c);
  const setNode = dc.nodes[setId] ?? Object.values(dc.nodes).find((n) => n.type === "componentSet");
  const kidNames = setNode.children.map((k) => dc.nodes[k].name);
  check("combine_variants keeps the written property order in the names", JSON.stringify(kidNames) === JSON.stringify(names), JSON.stringify(kidNames));
  await select(c, [setNode.id]);
  await c.waitForTimeout(400);
  const setKeys = () => c.locator('input[aria-label="Property name"]').evaluateAll((els) => els.map((e) => e.value));
  check("the set panel lists Size, State, Icon", JSON.stringify(await setKeys()) === JSON.stringify(["Size", "State", "Icon"]), JSON.stringify(await setKeys()));
  await shot(c, "c2-set-panel");

  // An instance's pickers follow the same order.
  const inst = await tool(c, "create_instance", { componentId: setNode.children[0] });
  await select(c, [inst.result.id]);
  await c.waitForTimeout(400);
  const pickerOrder = await c.locator(".wf-prop-label").evaluateAll((els) => els.map((e) => e.textContent.trim()));
  check("the instance pickers read Size, State, Icon", JSON.stringify(pickerOrder.slice(0, 3)) === JSON.stringify(["Size", "State", "Icon"]), JSON.stringify(pickerOrder));
  const pickedInst = (await doc(c)).nodes[inst.result.id];
  check("the instance landed outside the set", !pickedInst.parent);

  // Renaming State keeps its row position and its place in every name.
  await select(c, [setNode.id]);
  await c.waitForTimeout(300);
  const stateInput = c.locator('input[aria-label="Property name"]').nth(1);
  await stateInput.fill("Mode");
  await stateInput.press("Enter");
  await c.waitForTimeout(400);
  dc = await doc(c);
  const afterRename = dc.nodes[setNode.id].children.map((k) => dc.nodes[k].name);
  check("renaming State keeps its position in every name", afterRename[0] === "Size=S, Mode=Default, Icon=None" && afterRename[2] === "Size=L, Mode=Default, Icon=Left", JSON.stringify(afterRename));
  check("and its row", JSON.stringify(await setKeys()) === JSON.stringify(["Size", "Mode", "Icon"]), JSON.stringify(await setKeys()));
  // A new property goes last.
  await c.getByRole("button", { name: /Property$/ }).first().click();
  await c.waitForTimeout(400);
  dc = await doc(c);
  const afterAdd = dc.nodes[setNode.id].children.map((k) => dc.nodes[k].name);
  check("a new property goes last in the names", afterAdd.every((n) => /^Size=.*, Mode=.*, Icon=.*, Property \d=Default$/.test(n)), JSON.stringify(afterAdd));
  check("and in the panel", (await setKeys()).slice(-1)[0].startsWith("Property "), JSON.stringify(await setKeys()));
  await c.keyboard.press("Escape");

  // The Assets list labels each variant in the same order.
  await c.getByRole("tab", { name: /Assets/i }).first().click().catch(async () => c.getByText("Assets", { exact: true }).first().click());
  await c.waitForTimeout(500);
  const assetText = await c.locator(".asset-set, .layer").allTextContents();
  check("the Assets variant label lists values in property order", assetText.some((t) => /^(Insert instance of [^/]*\/ )?S, Default, None/.test(t.trim())), JSON.stringify(assetText.slice(0, 12)));
  await shot(c, "c2-assets");
  await c.close();

  // ----------------------------------------------------------------- C-4: names-only search
  const d = await openFile(dark);
  await tool(d, "create_nodes", {
    nodes: [
      {
        type: "frame", name: "Screen", x: 0, y: 0, width: 400, height: 400, layout: { direction: "vertical", gap: 8, padding: 16 },
        children: [
          { type: "frame", name: "Button/Primary", width: 160, height: 40, children: [{ type: "text", name: "Label", text: "Press the button" }] },
          { type: "frame", name: "Button/Secondary", width: 160, height: 40, children: [{ type: "text", name: "Label", text: "Or this button" }] },
          { type: "text", name: "Title", text: "Hello" },
          { type: "text", name: "Hint", text: "Tap a Button below" },
        ],
      },
    ],
  });
  await d.waitForTimeout(400);
  const search = d.getByRole("textbox", { name: "Search layers" });
  const count = async () => (await d.locator(".layer-search-count span").first().textContent().catch(() => "")) ?? "";
  await search.fill("button");
  await d.waitForTimeout(500);
  check("Match text content is on by default: 2 names and 3 texts match", /^5 matches$/.test((await count()).trim()), await count());
  check("the placeholder says Search layers", (await search.getAttribute("placeholder")) === "Search layers");
  await d.getByRole("button", { name: "Filter layers" }).click();
  const toggle = d.getByRole("checkbox", { name: "Match text content" });
  check("the filter menu has the toggle, checked", await toggle.isChecked());
  await shot(d, "c4-filter-menu-dark");
  await toggle.uncheck();
  await d.waitForTimeout(400);
  check("names only: 2 matches", /^2 matches$/.test((await count()).trim()), await count());
  check("the placeholder reads Search layer names", (await search.getAttribute("placeholder")) === "Search layer names");
  const stored = await d.evaluate(() => localStorage.getItem("dt:layer-search-content"));
  check("the choice is kept in localStorage", stored === "0", stored);
  await toggle.check();
  await d.waitForTimeout(300);
  check("turning it back on restores the 5 matches", /^5 matches$/.test((await count()).trim()), await count());
  await toggle.uncheck();
  await d.reload({ waitUntil: "domcontentloaded" });
  // The file may come back on its own; else start a new one.
  const back = await d.waitForSelector("#dt-canvas", { timeout: 5000 }).catch(() => null);
  if (!back) {
    await d.getByText("New design file").first().click();
    await d.waitForSelector("#dt-canvas");
  }
  await d.waitForTimeout(600);
  const search2 = d.getByRole("textbox", { name: "Search layers" });
  check("after a reload the toggle is still off", (await search2.getAttribute("placeholder")) === "Search layer names", await search2.getAttribute("placeholder"));
  await d.getByRole("button", { name: "Filter layers" }).click();
  check("and the checkbox is unchecked", !(await d.getByRole("checkbox", { name: "Match text content" }).isChecked()));
  await d.close();

  // ------------------------------------------------------------------------------- imports
  const openVariables = async (p) => {
    await p.evaluate(() => window.__dt.dispatch({ op: "select", ids: [], mode: "replace" }));
    await p.getByRole("button", { name: /Open variables/ }).first().click();
    await p.waitForSelector(".variables-dialog");
  };
  const importText = async (p, name, text) => {
    await p.locator("[data-var-import-input]").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(text) });
    await p.waitForSelector("[data-var-import-report]", { timeout: 5000 });
    await p.waitForTimeout(300);
  };
  const reportText = (p) => p.locator("[data-var-import-report]").first().textContent();
  // Alias ids differ between files: compare them by the target's name.
  const withAliasNames = (d) => {
    const names = {};
    for (const c of d.variables) for (const v of c.variables) names[v.id] = `${c.name}/${v.name}`;
    return JSON.stringify(
      d.variables.map((c) => ({
        name: c.name,
        modes: c.modes.map((m) => m.name),
        vars: c.variables
          .map((v) => ({
            name: v.name,
            type: v.type,
            desc: v.description,
            scopes: v.scopes ?? [],
            values: c.modes.map((m) => {
              const x = v.values[m.id];
              return x && x.alias ? { alias: names[x.alias] } : x;
            }),
          }))
          .sort((x, y) => x.name.localeCompare(y.name)),
      })),
    );
  };

  // A two-mode file, exported and imported into a new file.
  const src = await openFile(dark);
  await tool(src, "define_variables", { collection: "Primitives", variables: [{ name: "Gray/0", type: "color", value: "#FFFFFF" }, { name: "Gray/900", type: "color", value: "#101828" }, { name: "Space/8", type: "number", value: 8 }] });
  await tool(src, "define_variables", {
    collection: "Theme",
    modes: ["Light", "Dark"],
    variables: [
      { name: "Surface", type: "color", values: { Light: { alias: "Primitives/Gray/0" }, Dark: { alias: "Primitives/Gray/900" } } },
      { name: "Font", type: "string", values: { Light: "Inter", Dark: "Georgia" } },
      { name: "Compact", type: "boolean", value: true },
    ],
  });
  const exported = await src.evaluate(() => window.__dt.query({ q: "tokensJson" }));
  const srcDoc = await doc(src);
  await src.close();

  const imp = await openFile(dark);
  await openVariables(imp);
  check("Import JSON is offered", (await imp.getByRole("button", { name: "Import JSON" }).count()) === 1);
  await importText(imp, "tokens.json", exported);
  const di = await doc(imp);
  check("a Designotron export imports back as the same collections, modes and values", withAliasNames(di) === withAliasNames(srcDoc), withAliasNames(di).slice(0, 200));
  const rep1 = await reportText(imp);
  check("the dialog shows the report", /tokens\.json/.test(rep1) && /2 collections added/.test(rep1) && /6 variables added/.test(rep1), rep1);
  await shot(imp, "import-designotron-dark");
  await imp.keyboard.press("Escape");
  await imp.waitForTimeout(200);

  // Tokens Studio: a collection with a mode per theme.
  await imp.evaluate(() => window.__dt.dispatch({ op: "select", ids: [], mode: "replace" }));
  await openVariables(imp);
  await importText(imp, "studio.json", fixture("tokens-studio.json"));
  const ds = await doc(imp);
  const tokens = ds.variables.find((c) => c.name === "Tokens");
  check("Tokens Studio: a collection with Light and Dark modes", tokens && JSON.stringify(tokens.modes.map((m) => m.name)) === JSON.stringify(["Light", "Dark"]), JSON.stringify(ds.variables.map((c) => [c.name, c.modes.map((m) => m.name)])));
  const bg = tokens?.variables.find((v) => v.name === "color/bg");
  check("each theme has its own value", bg && bg.values[tokens.modes[0].id] === "#F8F8FA" && bg.values[tokens.modes[1].id] === "#111111", JSON.stringify(bg?.values));
  const rep2 = await reportText(imp);
  check("the report counts what was skipped", /skipped/.test(rep2), rep2);
  await imp.getByRole("button", { name: /skipped/ }).click();
  const list2 = await imp.locator(".var-import-skipped").textContent();
  check("the skipped list names the shadow", /elevation/.test(list2), list2);
  await shot(imp, "import-studio-dark");
  await imp.keyboard.press("Escape");
  await imp.waitForTimeout(200);

  // DTCG into a file of its own: the shadow is skipped with a reason; Ctrl+Z removes the import.
  const before = (await doc(imp)).variables.length;
  await openVariables(imp);
  await importText(imp, "brand-tokens.json", fixture("tokens-dtcg.json"));
  const dd = await doc(imp);
  const brand = dd.variables.find((c) => c.name === "brand-tokens");
  check("DTCG: one collection named after the file with 13 variables", brand && brand.variables.length === 13 && brand.modes.length === 1, brand && brand.variables.length);
  const soft = brand?.variables.find((v) => v.name === "color/brand/soft");
  check("a colour object becomes a hex colour", soft && Object.values(soft.values)[0] === "#FF800080", JSON.stringify(soft?.values));
  const text3 = await reportText(imp);
  check("the report says 3 skipped", /3 skipped/.test(text3), text3);
  await imp.getByRole("button", { name: /3 skipped/ }).click();
  const list3 = await imp.locator(".var-import-skipped").textContent();
  check("the skipped shadow is listed with the reason", /motion\/lift/.test(list3) && /composite/.test(list3), list3);
  await shot(imp, "import-dtcg-dark");
  const toast3 = await toastText(imp);
  check("a toast summarises the import", /Imported brand-tokens\.json/.test(toast3), toast3);
  await imp.keyboard.press("Escape");
  await imp.waitForTimeout(200);
  await imp.locator("#dt-canvas").click({ position: { x: 720, y: 450 } });
  await imp.keyboard.press("Control+z");
  await imp.waitForTimeout(400);
  const du = await doc(imp);
  check("one Ctrl+Z removes the whole DTCG import", du.variables.length === before && !du.variables.some((c) => c.name === "brand-tokens"), JSON.stringify(du.variables.map((c) => c.name)));
  await imp.keyboard.press("Control+z");
  await imp.waitForTimeout(300);
  check("and the next one removes the Tokens Studio import", !(await doc(imp)).variables.some((c) => c.name === "Tokens" || c.name === "Brand"));
  await imp.keyboard.press("Control+z");
  await imp.waitForTimeout(300);
  check("and the next the Designotron one", (await doc(imp)).variables.length === 0);

  // Errors stay in the dialog and change nothing.
  await openVariables(imp);
  await importText(imp, "broken.json", "{ nope");
  const bad = await reportText(imp);
  check("a file that isn't JSON gives one clear error", /not valid JSON/.test(bad), bad);
  check("and nothing changed", (await doc(imp)).variables.length === 0);
  await imp.close();

  // The Designotron round trip into a file that already has the collections updates, never duplicates.
  const rt = await openFile(dark);
  await openVariables(rt);
  await importText(rt, "tokens.json", exported);
  await rt.keyboard.press("Escape");
  await openVariables(rt);
  await importText(rt, "tokens.json", exported);
  const dr = await doc(rt);
  check("importing the same file twice leaves one copy of everything", dr.variables.length === 2 && dr.variables.reduce((n, c) => n + c.variables.length, 0) === 6, JSON.stringify(dr.variables.map((c) => [c.name, c.variables.length])));
  check("the second report says nothing changed", /Nothing changed/.test(await reportText(rt)), await reportText(rt));
  await rt.close();

  // -------------------------------------------------------------- light theme screenshots
  const lightCtx = await context("light");
  const lp = await openFile(lightCtx);
  await tool(lp, "create_nodes", { nodes: [{ type: "frame", name: "Button/Primary", x: 0, y: 0, width: 160, height: 40, children: [{ type: "text", name: "Label", text: "Press" }] }] });
  await lp.getByRole("textbox", { name: "Search layers" }).fill("button");
  await lp.getByRole("button", { name: "Filter layers" }).click();
  await lp.waitForTimeout(300);
  await shot(lp, "c4-filter-menu-light");
  await lp.keyboard.press("Escape");
  await lp.evaluate(() => window.__dt.dispatch({ op: "select", ids: [], mode: "replace" }));
  await lp.getByRole("button", { name: /Open variables/ }).first().click();
  await lp.waitForSelector(".variables-dialog");
  await lp.locator("[data-var-import-input]").setInputFiles({ name: "brand-tokens.json", mimeType: "application/json", buffer: Buffer.from(fixture("tokens-dtcg.json")) });
  await lp.waitForSelector("[data-var-import-report]");
  await lp.getByRole("button", { name: /3 skipped/ }).click();
  await lp.waitForTimeout(300);
  await shot(lp, "import-dtcg-light");
  await lp.close();
  await lightCtx.close();

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (err) {
  failed++;
  console.log("FAIL  script error  - " + (err?.stack ?? err));
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
