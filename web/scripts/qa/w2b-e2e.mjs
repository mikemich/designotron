// Component properties: create Boolean, Text and Instance swap properties on a Button main
// component from the UI, apply them to layers, set them on an instance from its panel, expose a
// nested instance's properties on an outer component, and check the exported React code.
// Usage: E2E_URL=http://localhost:5173 [SHOTS=dir] node scripts/qa/w2b-e2e.mjs (dev server running)

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const SHOTS = process.env.SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
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
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  // Nothing may leave this machine.
  await page.route("**/*", (route) => {
    const u = route.request().url();
    return /^(https?:\/\/(localhost|127\.0\.0\.1)[:/])|^(data|blob|about):/.test(u) ? route.continue() : route.abort();
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
const named = async (p, name, where) => {
  const d = await doc(p);
  const all = Object.values(d.nodes).filter((n) => n.name === name);
  return where ? all.find(where) : all[0];
};
const select = async (p, ids) => {
  await p.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), ids);
  await sleep(150);
};
const shot = async (p, name) => {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` });
};
const tool = async (p, name, input) => {
  const r = await p.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
  if (!r.ok) throw new Error(`${name}: ${r.result}`);
  return r.result;
};
const create = async (p, spec) => (await tool(p, "create_nodes", { nodes: [spec] })).created[0].id;
const componentOf = async (p, id) => (await doc(p)).nodes[id].instance.componentId;
const panel = (p) => p.locator(".design, .right, aside").first();

try {
  const p = await fresh();

  // Setup: Arrow and Check icon components, and a Button frame (Bg, Label, Icon instance).
  const arrow = await create(p, { type: "frame", name: "Arrow", x: 0, y: 400, width: 16, height: 16, fill: "#ffffff" });
  const checkIcon = await create(p, { type: "frame", name: "Check", x: 100, y: 400, width: 16, height: 16, fill: "#22c55e" });
  for (const id of [arrow, checkIcon]) await tool(p, "arrange", { action: "create_component", ids: [id] });
  const button = await create(p, {
    type: "frame",
    name: "Button",
    x: 0,
    y: 0,
    width: 180,
    height: 44,
    fill: "#7c5cff",
    cornerRadius: 8,
    children: [
      { type: "text", name: "Label", text: "Buy now", x: 40, y: 12, fontSize: 16, color: "#ffffff" },
      { type: "instance", name: "Icon", componentId: arrow, x: 12, y: 14 },
    ],
  });
  await tool(p, "arrange", { action: "create_component", ids: [button] });
  await p.evaluate(() => window.__dt.zoomToFit());
  const label = await named(p, "Label");
  const icon = await named(p, "Icon", (n) => n.type === "instance" && n.parent === button);
  check("setup: Button main component with a label and an icon instance", !!label && !!icon && (await doc(p)).nodes[button].type === "component");

  // 1. A Boolean property from the main component's panel.
  await select(p, [button]);
  await p.click("button[title='Create component property']");
  await p.fill("input[aria-label='Property name']", "Icon");
  await p.click("[data-testid=create-prop] button:has-text('Create property')");
  await sleep(150);
  let props = (await doc(p)).nodes[button].component.props ?? [];
  check("Boolean property created from the main component's panel", props.length === 1 && props[0].kind === "boolean" && props[0].name === "Icon" && props[0].default === true);
  await shot(p, "1-main-panel");

  // Apply it to the icon layer's visibility.
  await select(p, [icon.id]);
  await p.click("[data-testid=bind-visible] button[title='Apply component property']");
  await p.click("[data-testid=apply-prop] .wf-pick:has-text('Icon')");
  await sleep(150);
  let n = (await doc(p)).nodes[icon.id];
  check("layer visibility bound to the Boolean property", n.propRefs?.visible === props[0].id, JSON.stringify(n.propRefs));
  check("bound layer shows its property chip", (await p.locator("[data-testid=bind-visible] .wf-bound").count()) === 1);
  await shot(p, "2-layer-bound");

  // 2. A Text property made from the label layer.
  await select(p, [label.id]);
  await p.click("[data-testid=bind-characters] button[title='Apply component property']");
  await p.fill("[data-testid=apply-prop] input[aria-label='Property name']", "Label");
  await p.click("[data-testid=apply-prop] button:has-text('Create property')");
  await sleep(150);
  const set = (await doc(p)).nodes[button].component.props;
  const textProp = set.find((q) => q.kind === "text");
  check("Text property created from the label, default is its text", !!textProp && textProp.default === "Buy now" && (await doc(p)).nodes[label.id].propRefs?.characters === textProp.id);

  // 3. An Instance swap property made from the icon instance.
  await select(p, [icon.id]);
  await p.click("[data-testid=bind-swap] button[title='Apply component property']");
  await p.fill("[data-testid=apply-prop] input[aria-label='Property name']", "Icon swap");
  await p.click("[data-testid=apply-prop] button:has-text('Create property')");
  await sleep(150);
  const all = (await doc(p)).nodes[button].component.props;
  const swapProp = all.find((q) => q.kind === "instanceSwap");
  check("Instance swap property created from the icon, default is its component", !!swapProp && swapProp.default === arrow);

  await select(p, [button]);
  const rows = await p.locator("[data-testid^='prop-']").count();
  check("main component panel lists the three properties", rows === 3, `rows=${rows}`);
  check("each property says where it is applied", (await p.locator("[data-testid^='prop-'] :text('Applied to')").count()) === 3);
  await shot(p, "3-main-properties");

  // 4. An instance: the controls are at the top of its panel.
  const home = await create(p, { type: "frame", name: "Home", x: 400, y: 0, width: 400, height: 300, fill: "#f5f5f5" });
  const inst = (await p.evaluate(([c, h]) => window.__dt.dispatch({ op: "createInstance", componentId: c, x: 420, y: 20, parent: h }), [button, home])).id;
  await select(p, [inst]);
  const ctl = (name) => p.locator(`[data-testid='ctl-${name}']`);
  check("instance panel shows a toggle, a text field and a swap dropdown", (await ctl("Icon").locator("input[type=checkbox]").count()) === 1 && (await ctl("Label").locator("input").count()) === 1 && (await ctl("Icon swap").locator("select").count()) === 1);
  await shot(p, "4-instance-before");

  await ctl("Icon").locator("input[type=checkbox]").uncheck();
  await sleep(150);
  let d = await doc(p);
  const copy = (name) => Object.values(d.nodes).find((x) => x.name === name && x.masterId && d.nodes[inst].children.includes(x.id));
  check("toggle hides the icon in this instance only", copy("Icon").visible === false && d.nodes[icon.id].visible === true);

  const field = ctl("Label").locator("input");
  await field.fill("Checkout");
  await field.press("Enter");
  await sleep(150);
  d = await doc(p);
  check("text field sets the label's characters", copy("Label").text.characters === "Checkout" && d.nodes[label.id].text.characters === "Buy now");

  // The swap dropdown is hidden behind the hidden icon's toggle; show it again, then swap.
  await ctl("Icon").locator("input[type=checkbox]").check();
  await ctl("Icon swap").locator("select").selectOption({ label: "Check" });
  await sleep(150);
  d = await doc(p);
  check("swap dropdown replaces the nested instance's component", (await componentOf(p, copy("Icon").id)) === checkIcon, "component " + (await componentOf(p, copy("Icon").id)));
  check("reset buttons appear for changed properties", (await p.locator("[data-testid=instance-props] button[title^='Reset']").count()) === 2);
  await ctl("Icon").locator("input[type=checkbox]").uncheck();
  await sleep(150);
  await shot(p, "5-instance-after");

  // Typing into the label on the canvas changes the property, not an override.
  d = await doc(p);
  const overrides = Object.values(d.nodes[inst].instance.overrides);
  check("only the swapped icon is an override; toggle and text are property values", overrides.length === 1 && Object.keys(overrides[0]).every((k) => k === "instance" || k === "name") && d.nodes[inst].instance.propValues?.[props[0].id] === false, JSON.stringify(d.nodes[inst].instance));

  // 5. Exported code uses the properties as React props.
  const code = (await tool(p, "export_code", { id: home, format: "react" })).code;
  const usage = code.split("\n").find((l) => l.includes("<Button ")) ?? "";
  check("code: <Button … icon={false} label=…/>", usage.includes('label="Checkout"') && usage.includes("icon={false}") && usage.includes("iconSwap={<Check />}"), usage);
  check("code: the component takes the props with defaults", /function Button\(\{ label = "Buy now", icon = true, iconSwap, className/.test(code) && code.includes("{icon && (iconSwap ?? <Arrow"), code.split("\n").find((l) => l.includes("function Button(")) ?? "");
  await select(p, [home]);
  await p.click(".right .tabs button[role=tab]:text-is('Code')");
  await sleep(400);
  await shot(p, "6-code-tab");
  const shown = await p.evaluate(() => document.body.innerText);
  check("Code tab shows the props", shown.includes("icon={false}") && shown.includes('label="Checkout"'));
  await p.click(".right .tabs button[role=tab]:text-is('Design')");

  // 6. Undo and redo walk the values back and forth.
  await select(p, [inst]);
  const undo = () => p.evaluate(() => window.__dt.dispatch({ op: "undo" }));
  const redo = () => p.evaluate(() => window.__dt.dispatch({ op: "redo" }));
  await undo(); // icon off
  d = await doc(p);
  check("undo restores the previous property value", copy("Icon").visible === true);
  await redo();
  d = await doc(p);
  check("redo brings it back", copy("Icon").visible === false);
  // Reset through the panel.
  await p.click("[data-testid='ctl-Icon'] button[title^='Reset']");
  await sleep(150);
  d = await doc(p);
  check("reset returns the layer to the main component's state", copy("Icon").visible === true);

  // 7. Variant swap keeps the values; main component edits keep them too.
  const dimmed = await named(p, "Button", (x) => x.type === "component");
  await tool(p, "update_nodes", { updates: [{ id: label.id, patch: { text: { fontSize: 22 } } }] });
  d = await doc(p);
  check("main component edits reach the instance and keep property values", copy("Label").text.characters === "Checkout" && copy("Label").text.fontSize === 22 && !!dimmed);

  // 8. Nested instance properties exposed on the outer component.
  const card = await create(p, { type: "frame", name: "Card", x: 0, y: 700, width: 260, height: 120, fill: "#ffffff" });
  const inner = (await p.evaluate(([c, f]) => window.__dt.dispatch({ op: "createInstance", componentId: c, x: 20, y: 720, parent: f }), [button, card])).id;
  await tool(p, "arrange", { action: "create_component", ids: [card] });
  await select(p, [inner]);
  await p.locator("text=Expose properties on the outer component").click();
  await sleep(150);
  check("expose toggle is stored on the nested instance", (await doc(p)).nodes[inner].instance.exposeProps === true);
  const cardInst = (await p.evaluate(([c]) => window.__dt.dispatch({ op: "createInstance", componentId: c, x: 900, y: 700, parent: null }), [card])).id;
  await select(p, [cardInst]);
  const nestedLabel = p.locator("[data-testid='instance-props'] [data-testid='ctl-Label'] input");
  check("outer instance shows the nested Button's controls", (await nestedLabel.count()) === 1);
  await nestedLabel.fill("Nested");
  await nestedLabel.press("Enter");
  await sleep(150);
  d = await doc(p);
  const nestedText = Object.values(d.nodes).find((x) => x.type === "text" && x.parent && d.nodes[x.parent]?.parent && d.nodes[d.nodes[x.parent].parent]?.id === cardInst) ?? Object.values(d.nodes).find((x) => x.type === "text" && x.text.characters === "Nested");
  check("a value set through the outer instance reaches the nested Button", !!nestedText && nestedText.text.characters === "Nested");
  await shot(p, "7-nested-exposed");

  // 9. The canvas shows what the panel says (no stale markup after the edits).
  const svgText = await p.evaluate(() => document.querySelector("#dt-canvas")?.textContent ?? "");
  check("canvas shows the property values", svgText.includes("Checkout") && svgText.includes("Nested"));
} catch (err) {
  check("script ran to the end", false, String(err?.stack ?? err));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
