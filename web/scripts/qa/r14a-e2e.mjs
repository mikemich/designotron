// Round 14, package a (tokens and instances in the engine): V-01 a colour typed on a layer inside an
// instance (and on its root) survives Light -> High contrast -> Dark and edits of the main while a bound
// sibling keeps following the mode, one undo step, reset "Variables" binds it again, rebind/detach and a
// mode pin on an instance are overrides; V-07 a colour style and a variable replace each other; V-03
// pasting a themed layer into a file whose Theme lacks the mode brings the source's values; V-04 mode and
// collection names are unique (toast, field reverts, one block in tokens.css); A5 the instance reset menu
// lists the changed layers inside; Restore main component keeps the main's name; and, with E2E_BRIDGE, an
// override with a null binding reaching a second editor in a local room and its reset.
// Usage: a dev server (or a bridge serving web/dist), then
//   cd web && E2E_URL=http://127.0.0.1:6511 E2E_BRIDGE=http://127.0.0.1:6512 node scripts/qa/r14a-e2e.mjs
// Screenshots: E2E_OUT. Every non-local request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL_ = process.env.E2E_URL ?? "http://127.0.0.1:6511";
const BRIDGE = process.env.E2E_BRIDGE ?? "";
const OUT = process.env.E2E_OUT ?? "/tmp/r14a-shots";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
};
const local = (u) => ["localhost", "127.0.0.1"].includes(new URL(u).hostname);

const browser = await chromium.launch(launch);
const newCtx = async () => {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await c.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* sandboxed frames have no storage */
    }
  });
  await c.route("**/*", (route) => {
    const u = route.request().url();
    return local(u) || u.startsWith("data:") || u.startsWith("blob:") ? route.continue() : route.abort();
  });
  return c;
};
const errors = [];
const open = async (ctx, url = URL_) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await p.getByText("New design file").first().click();
  await p.waitForSelector("#dt-canvas", { timeout: 20000 });
  await p.waitForTimeout(800);
  return p;
};
const tool = (p, name, input) => p.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const doc = (p) => p.evaluate(() => window.__dt.doc());
const dispatch = (p, cmd) => p.evaluate((c) => window.__dt.dispatch(c), cmd);
const sel = (p, ids) => dispatch(p, { op: "select", ids: Array.isArray(ids) ? ids : [ids] });
const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nodes = (d) => Object.values(d.nodes);
const subtree = (d, id) => [id, ...(d.nodes[id]?.children ?? []).flatMap((c) => subtree(d, c))];
const named = (d, name, under) => {
  const ok = under ? new Set(subtree(d, under)) : null;
  return nodes(d).find((n) => n.name === name && (!ok || ok.has(n.id)));
};
const fillOf = (n) => (n?.fills?.[0]?.color ?? "").toUpperCase();
const pickItem = async (p, name) => {
  await p.getByRole("menuitem", { name, exact: true }).click();
  await sleep(250);
};
const coll = (d, name) => d.variables.find((c) => c.name === name);
const mode = (c, name) => c.modes.find((m) => m.name === name);
const setMode = (p, id, collName, modeName) =>
  tool(p, "update_nodes", { updates: [{ id, variableModes: { [collName]: modeName } }] });
const toastText = (p) => p.locator(".toast").first().textContent({ timeout: 2500 }).catch(() => "");
/** Types a colour into the first hex field of the Design panel. */
const typeHex = async (p, hex) => {
  const inputs = p.locator(".design-panel input, .panel input, aside input");
  const idx = await inputs.evaluateAll((els) => els.findIndex((e) => /^#?[0-9A-F]{6}$/i.test(e.value) && e.offsetParent !== null));
  if (idx < 0) return false;
  await inputs.nth(idx).fill(hex);
  await inputs.nth(idx).press("Enter");
  await sleep(300);
  return true;
};

const THEME = {
  collection: "Theme",
  modes: ["Light", "Dark", "High contrast"],
  variables: [
    { name: "Text/Primary", type: "color", values: { Light: "#0F172A", Dark: "#F8FAFC", "High contrast": "#FFFFFF" } },
    { name: "Accent", type: "color", values: { Light: "#2563EB", Dark: "#3B82F6", "High contrast": "#1D4ED8" } },
    { name: "Other", type: "color", values: { Light: "#AA0000", Dark: "#0000AA", "High contrast": "#00AA00" } },
  ],
};

/** A "Hold" frame with a bound main (Label and Hint bound to Text/Primary) and an instance of it inside. */
async function build(p) {
  await tool(p, "define_variables", THEME);
  const r = await tool(p, "create_nodes", {
    nodes: [
      {
        type: "component",
        name: "Card",
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        fill: "#000000",
        bind: { fill: "Accent" },
        layout: { direction: "vertical", gap: 4, padding: 8 },
        children: [
          { type: "text", name: "Label", text: "Get started", fontSize: 16, bind: { fill: "Text/Primary" } },
          { type: "text", name: "Hint", text: "Hint", fontSize: 12, bind: { fill: "Text/Primary" } },
          { type: "rectangle", name: "Icon", width: 16, height: 16, fill: "#CCCCCC" },
        ],
      },
      { type: "frame", name: "Hold", x: 600, y: 0, width: 400, height: 300, fill: "#FFFFFF" },
    ],
  });
  const [main, hold] = r.result.created.map((c) => c.id);
  const i = await tool(p, "create_instance", { componentId: main, x: 20, y: 20, parentId: hold });
  return { main, hold, inst: i.result.id };
}

try {
  const ctx = await newCtx();
  const p = await open(ctx);
  const { main, hold, inst } = await build(p);
  let d = await doc(p);
  const label = () => named(d, "Label", inst);
  const hint = () => named(d, "Hint", inst);
  check("setup: the instance's Label follows Text/Primary (Light)", fillOf(label()) === "#0F172A" && !!label().bindings.fill, fillOf(label()));

  // ---- V-01: a colour typed on the instance's layer
  await sel(p, label().id);
  await sleep(300);
  const typed = await typeHex(p, "00FF00");
  d = await doc(p);
  check("typed 00FF00 in the Design panel", typed && fillOf(label()) === "#00FF00");
  check("the typed colour unbinds the layer", !label().bindings.fill);
  const rec = d.nodes[inst].instance.overrides[label().masterId];
  check("the override holds bindings.fill = null", rec?.bindings?.fill === null, JSON.stringify(rec?.bindings));
  const theme = coll(d, "Theme");
  await setMode(p, hold, "Theme", "High contrast");
  d = await doc(p);
  check("Light -> High contrast: the typed colour stays", fillOf(label()) === "#00FF00", fillOf(label()));
  check("High contrast: the bound Hint follows the mode", fillOf(hint()) === "#FFFFFF", fillOf(hint()));
  await setMode(p, hold, "Theme", "Dark");
  d = await doc(p);
  check("-> Dark: the typed colour stays", fillOf(label()) === "#00FF00", fillOf(label()));
  check("Dark: the bound Hint follows the mode", fillOf(hint()) === "#F8FAFC", fillOf(hint()));
  await dispatch(p, { op: "update", ids: [main], patch: { cornerRadius: 12 } });
  d = await doc(p);
  check("an edit of the main keeps the typed colour and the binding of the sibling", fillOf(label()) === "#00FF00" && !!hint().bindings.fill && d.nodes[inst].cornerRadius === 12);
  await shot(p, "v01-layer");

  // reset Variables from the layer menu
  await sel(p, label().id);
  await sleep(300);
  await p.getByTestId("overrides-reset").click();
  await pickItem(p, "Reset variables");
  d = await doc(p);
  check("Reset variables binds the layer to the token again (Dark value)", !!label().bindings.fill && fillOf(label()) === "#F8FAFC", fillOf(label()));

  // one undo step
  await sel(p, label().id);
  await sleep(300);
  await typeHex(p, "FF00FF");
  d = await doc(p);
  await dispatch(p, { op: "undo" });
  d = await doc(p);
  check("typing the colour is one undo step: one undo gives back the binding and the token colour", !!label().bindings.fill && fillOf(label()) === "#F8FAFC" && !d.nodes[inst].instance.overrides[label().masterId]?.bindings);

  // ---- V-01: the instance root
  await setMode(p, hold, "Theme", "Light");
  await sel(p, inst);
  await sleep(300);
  d = await doc(p);
  check("setup: the root follows Accent", !!d.nodes[inst].bindings.fill && fillOf(d.nodes[inst]) === "#2563EB", fillOf(d.nodes[inst]));
  await typeHex(p, "00FF00");
  d = await doc(p);
  check("root: typed colour, binding gone, override records null", fillOf(d.nodes[inst]) === "#00FF00" && !d.nodes[inst].bindings.fill && d.nodes[inst].instance.overrides.__root?.bindings?.fill === null);
  await setMode(p, hold, "Theme", "High contrast");
  await dispatch(p, { op: "update", ids: [main], patch: { cornerRadius: 6 } });
  await setMode(p, hold, "Theme", "Dark");
  d = await doc(p);
  check("root: Light -> High contrast -> Dark and a main edit keep the typed colour", fillOf(d.nodes[inst]) === "#00FF00");
  await shot(p, "v01-root");

  // rebind, detach and a mode pin are overrides too
  await dispatch(p, { op: "bindVariable", ids: [label().id], property: "fill", variable: "Theme/Other" });
  await dispatch(p, { op: "update", ids: [main], patch: { cornerRadius: 7 } });
  d = await doc(p);
  check("rebinding a layer's fill survives a main edit", label().bindings.fill === coll(d, "Theme").variables.find((v) => v.name === "Other").id && fillOf(label()) === "#0000AA");
  await dispatch(p, { op: "bindVariable", ids: [hint().id], property: "fill", variable: null });
  await dispatch(p, { op: "update", ids: [main], patch: { cornerRadius: 8 } });
  d = await doc(p);
  check("detaching keeps the painted colour and survives a main edit", !hint().bindings.fill && fillOf(hint()) === "#F8FAFC", fillOf(hint()));
  await setMode(p, hold, "Theme", "Light");
  d = await doc(p);
  check("a detached layer no longer follows the frame's mode", fillOf(hint()) === "#F8FAFC");
  await dispatch(p, { op: "setVariableMode", ids: [inst], collection: "Theme", mode: "Dark" });
  await dispatch(p, { op: "update", ids: [main], patch: { cornerRadius: 9 } });
  d = await doc(p);
  check("a mode picked on the instance survives a main edit", Object.values(d.nodes[inst].variableModes).includes(mode(coll(d, "Theme"), "Dark").id));
  await dispatch(p, { op: "setVariableMode", ids: [inst], collection: "Theme", mode: null });
  await dispatch(p, { op: "update", ids: [main], patch: { cornerRadius: 10 } });
  d = await doc(p);
  check("clearing the pin removes it for good", Object.keys(d.nodes[inst].variableModes).length === 0);

  // ---- A5: the instance's reset menu lists the layers inside
  await dispatch(p, { op: "resetInstance", ids: [inst] });
  await dispatch(p, { op: "setText", id: label().id, characters: "Hello" });
  await dispatch(p, { op: "update", ids: [named(d, "Icon", inst).id], patch: { fills: [{ type: "solid", color: "#FF0000" }] } });
  await sel(p, inst);
  await sleep(300);
  await p.getByTestId("instance-reset").click();
  const headings = await p.getByText("Layers inside", { exact: true }).count();
  const labelItem = await p.getByRole("menuitem", { name: "Label: Text", exact: true }).count();
  const iconItem = await p.getByRole("menuitem", { name: "Icon: Fill", exact: true }).count();
  check("the reset menu lists the changed layers inside", headings === 1 && labelItem === 1 && iconItem === 1, `${headings}/${labelItem}/${iconItem}`);
  await shot(p, "a5-menu");
  await pickItem(p, "Label: Text");
  d = await doc(p);
  check("choosing it restores the label text and keeps the icon override", label().text.characters === "Get started" && fillOf(named(d, "Icon", inst)) === "#FF0000");

  // ---- V-07: a style and a variable replace each other
  await tool(p, "define_styles", { colors: [{ name: "Brand/Accent", color: "#FF00FF" }] });
  d = await doc(p);
  const styleId = d.styles.colors.find((s) => s.name === "Brand/Accent").id;
  await tool(p, "create_nodes", { nodes: [{ type: "rectangle", name: "Swatch", x: 1100, y: 0, width: 60, height: 60, fill: "#123456", bind: { fill: "Accent" } }] });
  d = await doc(p);
  const sw = () => named(d, "Swatch");
  await sel(p, sw().id);
  await sleep(300);
  await dispatch(p, { op: "applyStyle", ids: [sw().id], styleId });
  d = await doc(p);
  check("applying a style removes the variable", !sw().bindings.fill && sw().fillStyle === styleId && fillOf(sw()) === "#FF00FF");
  await sleep(300);
  check("the Fill row shows only the style chip", (await p.getByText("Brand/Accent").count()) > 0 && (await p.getByText("Accent", { exact: true }).count()) === 0);
  await shot(p, "v07-style");
  await dispatch(p, { op: "bindVariable", ids: [sw().id], property: "fill", variable: "Theme/Accent" });
  d = await doc(p);
  check("binding a variable detaches the style", !!sw().bindings.fill && !sw().fillStyle);
  await sleep(300);
  await shot(p, "v07-variable");
  check("the Fill row shows only the variable chip", (await p.getByText("Brand/Accent").count()) === 0 && (await p.getByText("Accent", { exact: true }).count()) > 0);
  await dispatch(p, { op: "bindVariable", ids: [sw().id], property: "stroke", variable: "Theme/Accent" });
  await dispatch(p, { op: "applyStyle", ids: [sw().id], styleId, kind: "stroke" });
  d = await doc(p);
  check("strokes work the same way", !sw().bindings.stroke && sw().strokeStyle === styleId && !!sw().bindings.fill);

  // ---- V-04: unique names through the dialog
  await p.mouse.click(300, 800);
  await p.keyboard.press("Escape").catch(() => {});
  await p.getByRole("button", { name: "Open variables" }).first().click();
  await sleep(250);
  await p.locator(".var-coll", { hasText: "Theme" }).click();
  const head = p.locator("thead input.textinput.head").nth(2);
  const before = await head.inputValue();
  await head.fill("Dark");
  await head.press("Enter");
  await sleep(300);
  d = await doc(p);
  check("renaming High contrast to Dark is refused", coll(d, "Theme").modes.map((m) => m.name).join() === "Light,Dark,High contrast");
  const t = await toastText(p);
  check("an error toast says why", /already exists/i.test(t), t);
  check("the field reverts", (await head.inputValue()) === before, await head.inputValue());
  const exp = await tool(p, "export_code", { format: "project" });
  const tokens = exp.result.files.find((f) => f.path === "src/tokens.css").content;
  check("tokens.css has one dark block for Theme", (tokens.match(/\[data-theme="dark"\]/g) ?? []).length === 1, JSON.stringify(tokens.match(/\[data-[^\]]+\]/g)));
  await shot(p, "v04-dialog");
  await p.keyboard.press("Escape");

  // ---- V-03: paste a themed layer into a file whose Theme lacks High contrast
  await tool(p, "create_nodes", {
    nodes: [{ type: "frame", name: "Landing", x: 0, y: 500, width: 300, height: 200, fill: "#000000", bind: { fill: "Accent" } }],
  });
  await tool(p, "define_variables", { collection: "Primitives", modes: ["Value"], variables: [{ name: "Black", type: "color", value: "#000000" }] });
  await tool(p, "define_variables", {
    collection: "Theme",
    modes: ["Light", "Dark", "High contrast"],
    variables: [{ name: "Surface", type: "color", values: { Light: "#FFFFFF", Dark: "#111111", "High contrast": { alias: "Primitives/Black" } } }],
  });
  d = await doc(p);
  const landing = named(d, "Landing");
  await dispatch(p, { op: "bindVariable", ids: [landing.id], property: "fill", variable: "Theme/Surface" });
  await setMode(p, landing.id, "Theme", "High contrast");
  d = await doc(p);
  check("source: Landing in High contrast is #000000", fillOf(named(d, "Landing")) === "#000000", fillOf(named(d, "Landing")));
  await p.mouse.click(300, 800);
  await sel(p, landing.id);
  await p.keyboard.press("Control+c");
  await sleep(300);
  await p.goto(URL_);
  await p.waitForSelector(".files");
  await p.click("button:has-text('New design file')");
  await p.waitForSelector("#dt-canvas");
  await sleep(300);
  await tool(p, "define_variables", { collection: "Theme", modes: ["Light", "Dark"], variables: [{ name: "Surface", type: "color", values: { Light: "#F0F0F0", Dark: "#111111" } }, { name: "Only here", type: "color", values: { Light: "#ABCDEF", Dark: "#123456" } }] });
  await p.keyboard.press("Control+v");
  await sleep(700);
  d = await doc(p);
  const th2 = coll(d, "Theme");
  const hc = mode(th2, "High contrast");
  check("the paste added the High contrast mode", !!hc);
  const surf = th2.variables.find((v) => v.name === "Surface");
  check("Surface in High contrast is the source's alias", !!hc && !!surf.values[hc.id]?.alias, JSON.stringify(surf.values[hc?.id]));
  check("Light and Dark keep the destination's values", surf.values[mode(th2, "Light").id] === "#F0F0F0" && surf.values[mode(th2, "Dark").id] === "#111111");
  const only = th2.variables.find((v) => v.name === "Only here");
  check("a destination-only variable takes its Light value", !!hc && only.values[hc.id] === "#ABCDEF");
  const pasted = named(d, "Landing");
  await setMode(p, pasted.id, "Theme", "High contrast");
  d = await doc(p);
  check("the pasted frame in High contrast has surface #000000", fillOf(named(d, "Landing")) === "#000000", fillOf(named(d, "Landing")));
  await shot(p, "v03-paste");

  // ---- Restore main component keeps the main's name
  const p2 = await open(await newCtx());
  const b = await build(p2);
  const i2 = await tool(p2, "create_instance", { componentId: b.main, x: 20, y: 150, parentId: b.hold });
  await dispatch(p2, { op: "delete", ids: [b.main] });
  await sel(p2, b.inst);
  await sleep(300);
  await p2.getByTestId("restore-main").click();
  await sleep(300);
  const d2 = await doc(p2);
  check("the restored main is named after its instances (Card)", d2.nodes[b.main]?.name === "Card", d2.nodes[b.main]?.name);
  void i2;

  check("no page errors so far", errors.length === 0, errors.slice(0, 3).join(" | "));

  // ---- collab: a null-binding override reaches the other editor, a reset too
  if (BRIDGE) {
    const octx = await newCtx();
    const owner = await open(octx, BRIDGE);
    const ob = await build(owner);
    await owner.click(".tbtn[title='Share for live editing']");
    await owner.fill(".share-dialog input.textinput >> nth=0", "Olga");
    await owner.click("button:has-text('Share on this network')");
    await owner.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 10000 });
    const link = (await owner.evaluate(() => window.__dt.collab().link)).replace(/^http:\/\/[^:/]+/, "http://127.0.0.1");
    await owner.keyboard.press("Escape");
    const gctx = await newCtx();
    const guest = await gctx.newPage();
    guest.on("pageerror", (e) => errors.push(String(e)));
    await guest.goto(link);
    await guest.waitForSelector("#dt-canvas");
    await guest.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 15000 });
    await guest.waitForFunction((i) => !!window.__dt.doc().nodes[i], ob.inst, { timeout: 8000 });
    let od = await doc(owner);
    const ol = named(od, "Label", ob.inst);
    await sel(owner, ol.id);
    await sleep(300);
    await typeHex(owner, "00FF00");
    await guest.waitForFunction((id) => (window.__dt.doc().nodes[id].fills[0]?.color ?? "").toUpperCase() === "#00FF00", ol.id, { timeout: 8000 }).catch(() => {});
    let gd = await doc(guest);
    check("the guest gets the typed colour with the unbound layer", fillOf(gd.nodes[ol.id]) === "#00FF00" && !gd.nodes[ol.id].bindings.fill);
    check("both sides hold the same override record (with the null)", JSON.stringify((await doc(owner)).nodes[ob.inst].instance.overrides) === JSON.stringify(gd.nodes[ob.inst].instance.overrides) && JSON.stringify(gd.nodes[ob.inst].instance.overrides).includes('"fill":null'));
    // the guest switches the frame to Dark: the owner's typed colour stays on both
    await setMode(guest, ob.hold, "Theme", "Dark");
    await owner.waitForFunction((h) => Object.keys(window.__dt.doc().nodes[h].variableModes ?? {}).length > 0, ob.hold, { timeout: 8000 }).catch(() => {});
    od = await doc(owner);
    check("after the guest's mode change the typed colour stays on the host", fillOf(od.nodes[ol.id]) === "#00FF00");
    await sel(guest, ol.id);
    await sleep(300);
    await guest.getByTestId("overrides-reset").click();
    await pickItem(guest, "Reset variables");
    await owner.waitForFunction((id) => !!window.__dt.doc().nodes[id].bindings.fill, ol.id, { timeout: 8000 }).catch(() => {});
    od = await doc(owner);
    check("the guest's reset binds the layer again on the host", !!od.nodes[ol.id].bindings.fill && fillOf(od.nodes[ol.id]) === "#F8FAFC", fillOf(od.nodes[ol.id]));
    await dispatch(guest, { op: "undo" });
    await owner.waitForFunction((id) => !window.__dt.doc().nodes[id].bindings.fill, ol.id, { timeout: 8000 }).catch(() => {});
    check("undoing the reset puts the unbound layer back on the host", !(await doc(owner)).nodes[ol.id].bindings.fill);
    await shot(guest, "collab-guest");
  }
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  failed++;
  console.log("FAIL  script error", e);
} finally {
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
