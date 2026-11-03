// W3-C: variable aliases and scopes, bound-value chips, effect / grid / stroke styles, slash
// folders and Assets thumbnails, driven through the UI.
// Usage: E2E_URL=http://localhost:5521 node scripts/qa/w3c-e2e.mjs (dev server running)
// Screenshots go to E2E_OUT (default /tmp/w3c-shots).

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const OUT = process.env.E2E_OUT ?? "/tmp/w3c-shots";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fresh() {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  await context.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith("data:") || u.startsWith("blob:") || /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)) return route.continue();
    return route.abort();
  });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  page.on("pageerror", (e) => check("no page errors", false, String(e)));
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  return page;
}
const doc = (p) => p.evaluate(() => window.__dt.doc());
const named = async (p, name) => Object.values((await doc(p)).nodes).find((n) => n.name === name);
const tool = (p, name, input) => p.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const select = (p, ids) => p.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), ids);
const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}.png` });
const leftTab = (p, name) => p.evaluate((n) => window.__dt && document.querySelector(`[role=tab][aria-label="${n}"], [role=tab]`)?.click(), name);

async function openAssets(p) {
  await p.getByRole("tab", { name: /assets/i }).click();
  await p.waitForSelector("[data-styles=colour]");
}
const toastText = (p) => p.$$eval("[role=status], .toast", (els) => els.map((e) => e.textContent).join(" | "));

// ---------------------------------------------------------------- A: aliases, cycles, scopes
{
  const p = await fresh();
  await tool(p, "define_variables", {
    collection: "Tokens",
    variables: [
      { name: "Space/base", type: "number", value: 8 },
      { name: "Space/card", type: "number", value: 16 },
      { name: "Radius/md", type: "number", value: 12 },
      { name: "Brand/Primary", type: "color", value: "#7C5CFF" },
    ],
  });
  await tool(p, "create_nodes", { nodes: [{ type: "frame", name: "Box", x: 0, y: 0, width: 200, height: 120, fill: "#EEEEEE", layout: { direction: "vertical", gap: 10, padding: 10 } }] });
  await p.getByRole("button", { name: /open variables/i }).first().click().catch(async () => {
    await p.evaluate(() => document.querySelector("button[title*=ariables]")?.click());
  });
  await p.waitForSelector(".variables-dialog");
  check("variables dialog lists variables inside slash folders", (await p.locator(".var-folder").count()) >= 3, `${await p.locator(".var-folder").count()} folders`);
  await shot(p, "a-dialog");

  // Alias Space/card to Space/base through the cell's Alias button.
  const row = p.locator("tr[data-variable='Space/card']");
  await row.locator("button[aria-label^='Alias']").click();
  await p.getByRole("menuitem", { name: "Space/base" }).click();
  await sleep(150);
  let d = await doc(p);
  const vars = d.variables[0].variables;
  const base = vars.find((v) => v.name === "Space/base");
  const card = vars.find((v) => v.name === "Space/card");
  const mode = d.variables[0].modes[0].id;
  check("alias is stored as {alias: id}", card.values[mode]?.alias === base.id, JSON.stringify(card.values[mode]));
  check("alias cell shows a chip with the target's name", (await p.locator("tr[data-variable='Space/card'] .var-alias").getAttribute("data-alias")) === "Space/base");

  // Cycle: base -> card is refused with a message.
  await p.locator("tr[data-variable='Space/base'] button[aria-label^='Alias']").click();
  await p.getByRole("menuitem", { name: "Space/card" }).click();
  await sleep(200);
  d = await doc(p);
  check("an alias cycle is refused and nothing changes", !d.variables[0].variables.find((v) => v.name === "Space/base").values[mode]?.alias);
  check("the refusal says why", /refers back|loop|cycle/i.test(await toastText(p)), await toastText(p));

  // Detach writes the resolved value.
  await p.locator("tr[data-variable='Space/card'] button[aria-label^='Detach alias']").click();
  await sleep(150);
  d = await doc(p);
  check("detaching an alias writes the resolved value", d.variables[0].variables.find((v) => v.name === "Space/card").values[mode] === 8);

  // Scope: Radius/md only for corner radius.
  await p.locator("tr[data-variable='Radius/md'] button[aria-label^='Where']").click();
  await p.getByLabel("Corner radius").check();
  await sleep(150);
  await p.keyboard.press("Escape");
  d = await doc(p);
  check("scope checkbox is saved on the variable", JSON.stringify(d.variables[0].variables.find((v) => v.name === "Radius/md").scopes) === '["cornerRadius"]');
  await shot(p, "a-scopes");
  await p.evaluate(() => window.__dt && document.querySelector(".variables-dialog button[title=Close]")?.click());

  // Binding pickers only list variables whose scope covers the property.
  const box = await named(p, "Box");
  await select(p, [box.id]);
  await p.locator("[aria-label='Bound variable']").first().waitFor({ state: "attached" }).catch(() => {});
  await p.locator(".section-head:has-text('Variables') button").first().click();
  const optionsFor = async (label) => {
    const row = p.locator(".row", { hasText: label }).filter({ has: p.locator("select[aria-label='Bound variable']") }).first();
    return row.locator("select option").allTextContents();
  };
  const radiusOpts = await optionsFor("Radius");
  const gapOpts = await optionsFor("Gap");
  check("radius picker lists the cornerRadius-scoped variable", radiusOpts.some((o) => o.includes("md")), radiusOpts.join(","));
  check("gap picker does not list it", !gapOpts.some((o) => o.includes("md")) && gapOpts.some((o) => o.includes("base")), gapOpts.join(","));
  check("new properties are bindable (per-side padding, line height, weight)", (await optionsFor("Pad left")).length > 1);

  // Bound chip with detach for a fill.
  await tool(p, "update_nodes", { updates: [{ id: box.id, bind: { fill: "Brand/Primary", cornerRadius: "Radius/md" } }] });
  await sleep(150);
  check("a bound fill shows the variable's name", (await p.locator("[data-bound-chip=fill]").textContent()).includes("Primary"));
  check("a bound radius shows a hint with the name", (await p.locator("[data-bound-chip=cornerRadius]").textContent()).includes("md"));
  await shot(p, "a-bound");
  await p.locator("[data-bound-chip=fill] button").click();
  await sleep(150);
  const after = await named(p, "Box");
  check("detaching keeps the value and drops the binding", !after.bindings.fill && after.fills[0].color.toUpperCase().startsWith("#7C5CFF"), JSON.stringify(after.bindings));
  await p.context().close();
}

// ---------------------------------------------------------------- B: effect, grid and stroke styles
{
  const p = await fresh();
  await tool(p, "create_nodes", {
    nodes: [
      { type: "frame", name: "Card A", x: 0, y: 0, width: 200, height: 120, fill: "#FFFFFF", shadow: { y: 8, blur: 24, color: "#00000040" }, layoutGrids: [{ pattern: "columns", count: 4 }] },
      { type: "frame", name: "Card B", x: 300, y: 0, width: 200, height: 120, fill: "#FFFFFF" },
    ],
  });
  await tool(p, "define_styles", { colors: [{ name: "Brand/Ink", color: "#111827" }, { name: "Brand/Accent", color: "#FF5500" }, { name: "Plain", color: "#00AA00" }] });
  const a = await named(p, "Card A");
  const b = await named(p, "Card B");
  await select(p, [a.id]);
  // Create an effect style from the Effects section.
  await p.getByRole("button", { name: "Create effect style from these effects" }).click();
  await sleep(150);
  let d = await doc(p);
  check("effect style created and linked", d.styles.effects?.length === 1 && (await named(p, "Card A")).effectStyle === d.styles.effects[0].id);
  check("the Effects section shows the style chip", (await p.locator("[data-style-chip=effect]").count()) === 1);
  await p.getByRole("button", { name: "Create grid style from these grids" }).click();
  await sleep(150);
  d = await doc(p);
  check("grid style created and linked", d.styles.grids?.length === 1 && (await named(p, "Card A")).gridStyle === d.styles.grids[0].id);

  // Apply to Card B through the header menu.
  await select(p, [b.id]);
  await p.getByRole("button", { name: "Apply effect style" }).click();
  await p.getByRole("menuitem").filter({ hasText: /Effect 1/ }).click();
  await sleep(150);
  const b1 = await named(p, "Card B");
  check("applying copies the effects and links", b1.effects.length === 1 && b1.effectStyle === d.styles.effects[0].id);

  // Edit in place from Assets: both cards follow.
  await openAssets(p);
  await shot(p, "b-assets");
  const fxRow = p.locator("[data-styles=effect] .wf-style-row").first();
  await fxRow.hover();
  await fxRow.getByRole("button", { name: "Edit style" }).click();
  const blur = p.locator("[data-styles=effect] .wf-fx input").first();
  const blurField = p.locator("[data-styles=effect] .wf-fx .field", { hasText: "Blur" }).locator("input");
  await blurField.fill("40");
  await blurField.press("Enter");
  await sleep(200);
  const aA = await named(p, "Card A");
  const bB = await named(p, "Card B");
  check("editing the style updates every linked layer", aA.effects[0].blur === 40 && bB.effects[0].blur === 40, `${aA.effects[0].blur}/${bB.effects[0].blur}`);
  check("...and nothing else on them changed", aA.fills[0].color === (await named(p, "Card A")).fills[0].color && aA.x === 0 && bB.x === 300);

  // Editing a linked layer's effects by hand detaches it.
  await select(p, [b.id]);
  await p.getByRole("tabpanel", { name: "Design" }).locator("select[aria-label='Effect type']").selectOption("innerShadow");
  await sleep(150);
  const b2 = await named(p, "Card B");
  check("hand-editing linked effects detaches the style", !b2.effectStyle && (await named(p, "Card A")).effectStyle);
  check("the chip is gone", (await p.locator("[data-style-chip=effect]").count()) === 0);

  // Stroke colour style from the Stroke section.
  await select(p, [a.id]);
  await p.getByRole("button", { name: "Add stroke" }).click();
  await p.getByRole("button", { name: "Apply colour style to stroke" }).click();
  await p.getByRole("menuitem", { name: "Brand/Ink" }).click();
  await sleep(150);
  const a3 = await named(p, "Card A");
  d = await doc(p);
  const ink = d.styles.colors.find((s) => s.name === "Brand/Ink");
  check("stroke colour style links strokeStyle, not fillStyle", a3.strokeStyle === ink.id && a3.fillStyle !== ink.id && a3.strokes[0].color.toUpperCase().startsWith("#111827"));
  check("the Stroke section shows the chip", (await p.locator("[data-style-chip=stroke]").count()) === 1);
  await openAssets(p);
  const inkRow = p.locator("[data-styles=colour] .wf-style", { hasText: "Ink" }).first();
  await inkRow.hover();
  await inkRow.getByRole("button", { name: "Edit style" }).click();
  const hex = inkRow.getByLabel("Colour (hex)");
  await hex.fill("123456");
  await hex.press("Enter");
  await sleep(150);
  check("editing the colour style recolours the stroke", (await named(p, "Card A")).strokes[0].color.toUpperCase().startsWith("#123456"));
  await shot(p, "b-stroke");

  // Delete keeps the values and unlinks.
  const row2 = p.locator("[data-styles=colour] .wf-style", { hasText: "Ink" }).first();
  await row2.getByRole("button", { name: "Delete style" }).click();
  await sleep(150);
  const a4 = await named(p, "Card A");
  check("deleting a style keeps the stroke and unlinks it", !a4.strokeStyle && a4.strokes[0].color.toUpperCase().startsWith("#123456"));

  // Undo restores the link.
  await p.keyboard.press("Control+z");
  await sleep(150);
  check("undo restores the style link", !!(await named(p, "Card A")).strokeStyle);
  await p.context().close();
}

// ---------------------------------------------------------------- C: folders, thumbnails, descriptions
{
  const p = await fresh();
  await tool(p, "define_styles", {
    colors: [
      { name: "Brand/Primary", color: "#7C5CFF" },
      { name: "Brand/Accent", color: "#FF5500" },
      { name: "Gray/100", color: "#F3F4F6" },
      { name: "White", color: "#FFFFFF" },
    ],
  });
  const comps = [];
  for (let i = 0; i < 40; i++) comps.push({ type: "component", name: i < 6 ? `Buttons/Btn ${i}` : `Card ${i}`, x: (i % 10) * 120, y: Math.floor(i / 10) * 120, width: 100, height: 100, fill: "#7C5CFF", ...(i === 0 ? { name: "Buttons/Primary" } : {}) });
  await tool(p, "create_nodes", { nodes: comps });
  const prim = await named(p, "Buttons/Primary");
  await p.evaluate((id) => window.__dt.dispatch({ op: "update", ids: [id], patch: { component: { description: "The main call to action" } } }), prim.id);
  await select(p, []);
  const before = await p.evaluate(() => (window.__dtThumbs ? window.__dtThumbs() : -1));
  check("no thumbnail is rendered while the Assets tab is hidden", before === 0 || before === -1, String(before));
  await openAssets(p);
  await sleep(700);
  const folders = await p.locator("[data-styles=colour] .asset-folder").allTextContents();
  check("colour styles with slashes form collapsible folders", folders.length === 2 && folders[0].startsWith("Brand") && folders[1].startsWith("Gray"), folders.join(" | "));
  const rowsBefore = await p.locator("[data-styles=colour] .wf-style-row").count();
  await p.locator("[data-styles=colour] .asset-folder", { hasText: "Brand" }).click();
  const rowsAfter = await p.locator("[data-styles=colour] .wf-style-row").count();
  check("collapsing a folder hides its styles", rowsAfter === rowsBefore - 2, `${rowsBefore} -> ${rowsAfter}`);
  check("rows show the name without the folder", (await p.locator("[data-styles=colour] .wf-style-name").allTextContents()).includes("100"));
  check("component names with slashes fold into a folder", (await p.locator("[data-styles=components] .asset-folder", { hasText: "Buttons" }).count()) === 1);
  const thumbs = await p.locator("[data-styles=components] .asset-thumb[data-thumb=ready] img").count();
  const total = await p.locator("[data-styles=components] .asset-row").count();
  const renders = await p.evaluate(() => (window.__dtThumbs ? window.__dtThumbs() : -1));
  check("a component's description shows under its name", (await p.locator("[data-styles=components] .asset-desc").allTextContents()).includes("The main call to action"));
  check("component rows show thumbnails", thumbs > 0, `${thumbs} thumbnails`);
  check("only rows in view are rendered", renders > 0 && renders < 40, `${renders} of ${total + 6} components rendered`);
  // A change re-renders only the component that changed.
  const src = () => p.locator("[data-styles=components] .asset-row", { hasText: "Primary" }).locator("img").getAttribute("src");
  await p.locator("[data-styles=components] .asset-row", { hasText: "Primary" }).scrollIntoViewIfNeeded();
  await sleep(300);
  const srcBefore = await src();
  const renders1 = await p.evaluate(() => window.__dtThumbs());
  await p.evaluate((id) => window.__dt.dispatch({ op: "update", ids: [id], patch: { fills: [{ type: "solid", color: "#00FF00", opacity: 1, visible: true }] } }), prim.id);
  await sleep(1200);
  const renders2 = await p.evaluate(() => window.__dtThumbs());
  check("editing a component refreshes its thumbnail", (await src()) !== srcBefore);
  check("...and re-renders only that one", renders2 - renders1 <= 2, `${renders2 - renders1} renders`);
  await shot(p, "c-assets");
  await p.context().close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
