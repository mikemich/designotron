// Round 13, package b (components): per-property and per-layer override reset (also through nested
// and swapped instances, one undo step each), the "Changed from main" row and the instance reset
// menu, Restore main component (panel and context menu) with the delete toast, "Component
// properties" on sets and variants (R-U1), the text editor opening on the second double-click inside a
// nested instance (R-U2), and a reset and a restore reaching a collaborator in a local room.
// Usage: a dev server (or a bridge serving web/dist), then
//   cd web && E2E_URL=http://127.0.0.1:6321 E2E_BRIDGE=http://127.0.0.1:6322 node scripts/qa/r13b-e2e.mjs
// Screenshots: E2E_OUT. The collab part needs E2E_BRIDGE (a bridge serving web/dist; its LAN share
// listener is the bridge port + 1). Every non-local request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL_ = process.env.E2E_URL ?? "http://127.0.0.1:6321";
const BRIDGE = process.env.E2E_BRIDGE ?? "";
const OUT = process.env.E2E_OUT ?? "/tmp/r13b-shots";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
};
const local = (u) => ["localhost", "127.0.0.1"].includes(new URL(u).hostname) || /^(192\.0\.2|10|192\.168)\./.test(new URL(u).hostname);

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
  await c.route("**/*", (route) => (local(route.request().url()) || route.request().url().startsWith("data:") || route.request().url().startsWith("blob:") ? route.continue() : route.abort()));
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
const selection = (p) => p.evaluate(() => window.__dt.state().selection);
const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toastText = (p) => p.locator(".toast").first().textContent({ timeout: 2500 }).catch(() => "");
const nodes = (d) => Object.values(d.nodes);
const named = (d, name, under) => {
  const ok = under ? new Set(subtree(d, under)) : null;
  return nodes(d).find((n) => n.name === name && (!ok || ok.has(n.id)));
};
const subtree = (d, id) => [id, ...(d.nodes[id]?.children ?? []).flatMap((c) => subtree(d, c))];
const fillOf = (n) => (n?.fills?.[0]?.color ?? "").toUpperCase();
const absOf = (d, n) => {
  let x = n.x;
  let y = n.y;
  for (let p = n.parent ? d.nodes[n.parent] : null; p; p = p.parent ? d.nodes[p.parent] : null) {
    x += p.x;
    y += p.y;
  }
  return { x, y, w: n.width, h: n.height };
};
const toClient = async (p, x, y) => {
  const box = await p.locator("#dt-canvas").boundingBox();
  const v = await p.evaluate(() => window.__dt.viewport());
  return { x: box.x + v.x + x * v.zoom, y: box.y + v.y + y * v.zoom };
};
const clickNode = async (p, n, opts = {}) => {
  const d = await doc(p);
  const a = absOf(d, n);
  const c = await toClient(p, a.x + (opts.dx ?? a.w / 2), a.y + (opts.dy ?? a.h / 2));
  if (opts.dbl) await p.mouse.dblclick(c.x, c.y);
  else await p.mouse.click(c.x, c.y, opts.button ? { button: opts.button } : undefined);
};
const fit = async (p) => {
  await p.keyboard.press("Shift+1");
  await sleep(300);
};
const undo = (p) => dispatch(p, { op: "undo" });
const redo = (p) => dispatch(p, { op: "redo" });
const undoDepth = async (p) => (await p.evaluate(() => window.__dt.state())).undoDepth ?? null;

/** A "Button" main (Bg-less frame with a Label), a variant, and a "Card" main holding a Button instance. */
async function build(p) {
  const r = await tool(p, "create_nodes", {
    nodes: [
      {
        type: "component",
        name: "Button",
        x: 0,
        y: 0,
        width: 160,
        height: 44,
        fill: "#6d28d9",
        cornerRadius: 8,
        layout: { direction: "horizontal", gap: 8, padding: [12, 24], align: "center", crossAlign: "center" },
        children: [{ type: "text", name: "Label", text: "Continue", fill: "#ffffff", fontSize: 16, fontWeight: 600 }],
      },
      {
        type: "component",
        name: "Button Alt",
        x: 0,
        y: 100,
        width: 160,
        height: 44,
        fill: "#047857",
        cornerRadius: 8,
        layout: { direction: "horizontal", gap: 8, padding: [12, 24], align: "center", crossAlign: "center" },
        children: [{ type: "text", name: "Label", text: "Continue", fill: "#fef3c7", fontSize: 16, fontWeight: 600 }],
      },
    ],
  });
  const [btn, alt] = r.result.created.map((c) => c.id);
  const c = await tool(p, "create_nodes", {
    nodes: [
      {
        type: "frame",
        name: "Card",
        x: 260,
        y: 0,
        width: 320,
        height: 200,
        fill: "#ffffff",
        cornerRadius: 12,
        layout: { direction: "vertical", gap: 16, padding: 24 },
        children: [
          { type: "text", name: "Title", text: "Pro plan", fontSize: 24, fontWeight: 700, fill: "#111111" },
          { type: "instance", name: "Buy", componentId: btn, width: 272, height: 44 },
        ],
      },
    ],
  });
  const cardId = c.result.created[0].id;
  await sleep(200);
  await sel(p, cardId);
  await p.keyboard.press("Control+Alt+k");
  await sleep(300);
  await tool(p, "create_nodes", { nodes: [{ type: "instance", name: "Card A", componentId: cardId, x: 640, y: 0, width: 320, height: 200 }] });
  await tool(p, "create_nodes", { nodes: [{ type: "instance", name: "Solo", componentId: btn, x: 0, y: 300, width: 160, height: 44 }] });
  await sleep(300);
  await fit(p);
  return { btn, alt, cardId };
}

/** The page's text without the toast. */
const pageText = (p) =>
  p.evaluate(() => {
    const c = document.body.cloneNode(true);
    c.querySelectorAll(".toast").forEach((t) => t.remove());
    return c.textContent;
  });
const items = async (p) => p.$$eval("[role=menu] [role=menuitem]", (els) => els.map((e) => e.textContent.trim()));
const pickItem = async (p, name) => {
  await p.getByRole("menuitem", { name, exact: true }).click();
  await sleep(250);
};

try {
  const ctx = await newCtx();
  const p = await open(ctx);
  const { btn, alt, cardId } = await build(p);
  let d = await doc(p);
  const solo = named(d, "Solo");
  check("fixtures: instance and card instance built", !!solo?.instance && !!named(d, "Card A")?.instance);

  // ---- override a text through the canvas (double-click, type) and a fill through the engine
  await clickNode(p, solo);
  await sleep(150);
  await clickNode(p, named(d, "Label", solo.id), { dbl: true });
  await sleep(300);
  check("a double-click on an instance's text opens the editor", (await p.locator(".text-editor").count()) === 1);
  await p.keyboard.press("Control+a");
  await p.keyboard.type("Buy now");
  await p.keyboard.press("Escape");
  await sleep(300);
  d = await doc(p);
  let label = named(d, "Label", solo.id);
  check("the typed text is an override", label.text.characters === "Buy now");
  await dispatch(p, { op: "update", ids: [label.id], patch: { fills: [{ type: "solid", color: "#ff0000" }] } });
  await sleep(200);
  await sel(p, label.id);
  await sleep(300);

  // ---- the row and the per-property reset
  const row = p.getByTestId("overrides-row");
  const rowText = await row.textContent();
  check("a changed layer shows what changed from main", /Changed from main/.test(rowText) && /Fill/.test(rowText) && /Text/.test(rowText), rowText);
  await shot(p, "overrides-row");
  await p.getByTestId("overrides-reset").click();
  await sleep(200);
  const menu = await items(p);
  check("the reset menu has all-changes first, then a group per item", menu[0] === "Reset all changes on this layer" && menu.includes("Reset fill") && menu.includes("Reset text"), menu.join(" | "));
  await shot(p, "reset-menu-layer");
  const before = await undoDepth(p);
  await pickItem(p, "Reset fill");
  d = await doc(p);
  label = named(d, "Label", solo.id);
  check("Reset fill puts the main's fill back and keeps the text", fillOf(label) === "#FFFFFF" && label.text.characters === "Buy now", fillOf(label));
  check("the row now lists only Text", /Text/.test(await row.textContent()) && !/Fill/.test(await row.textContent()), await row.textContent());
  const mainLabel = named(d, "Label", btn);
  await dispatch(p, { op: "update", ids: [mainLabel.id], patch: { fills: [{ type: "solid", color: "#00ffff" }] } });
  d = await doc(p);
  check("the reset fill follows later changes to the main", fillOf(named(d, "Label", solo.id)) === "#00FFFF", fillOf(named(d, "Label", solo.id)));
  await undo(p);
  await undo(p);
  d = await doc(p);
  check("one undo brings the fill override back (reset was one step)", fillOf(named(d, "Label", solo.id)) === "#FF0000" && named(d, "Label", solo.id).text.characters === "Buy now");
  await redo(p);
  d = await doc(p);
  check("redo resets it again", fillOf(named(d, "Label", solo.id)) === "#FFFFFF");
  // everything on the layer
  await sel(p, named(d, "Label", solo.id).id);
  await sleep(200);
  await p.getByTestId("overrides-reset").click();
  await pickItem(p, "Reset all changes on this layer");
  d = await doc(p);
  check("Reset all changes on this layer", named(d, "Label", solo.id).text.characters === "Continue" && (await p.getByTestId("overrides-row").count()) === 0);

  // ---- instance reset menu: root groups
  await dispatch(p, { op: "update", ids: [solo.id], patch: { width: 220 } });
  await dispatch(p, { op: "update", ids: [named(d, "Label", solo.id).id], patch: { text: { characters: "Zed" } } });
  await sel(p, solo.id);
  await sleep(300);
  await p.getByTestId("instance-reset").click();
  const imenu = await items(p);
  check("the instance menu lists reset-all then its root groups", imenu[0] === "Reset all changes" && imenu.includes("Reset size"), imenu.join(" | "));
  await shot(p, "reset-menu-instance");
  await pickItem(p, "Reset size");
  d = await doc(p);
  check("Reset size follows the main's width again", named(d, "Solo").width === 160 && named(d, "Label", solo.id).text.characters === "Zed", String(named(d, "Solo").width));
  await sel(p, solo.id);
  await sleep(300);
  await p.getByTestId("instance-reset").click();
  await pickItem(p, "Reset all changes");
  d = await doc(p);
  check("Reset all changes still resets the whole instance", named(d, "Label", solo.id).text.characters === "Continue", named(d, "Label", solo.id).text.characters);

  // ---- right-click menu on a layer inside an instance
  await dispatch(p, { op: "update", ids: [named(d, "Label", solo.id).id], patch: { text: { characters: "Menu me" } } });
  await sel(p, named(d, "Label", solo.id).id);
  await sleep(200);
  await clickNode(p, named(d, "Label", solo.id), { button: "right" });
  await sleep(250);
  const cm = await items(p);
  check("the canvas menu offers Reset changes on this layer", cm.includes("Reset changes on this layer") && cm.includes("Reset text"), cm.join(" | ").slice(0, 300));
  await pickItem(p, "Reset text");
  d = await doc(p);
  check("it resets the group", named(d, "Label", solo.id).text.characters === "Continue");

  // ---- through nesting: a deep layer's override reset through the outer instance
  const cardA = named(d, "Card A");
  const deepBuy = named(d, "Buy", cardA.id);
  const deepLabel = named(d, "Label", deepBuy.id);
  await dispatch(p, { op: "update", ids: [deepLabel.id], patch: { text: { characters: "Deep" }, fills: [{ type: "solid", color: "#123456" }] } });
  await sel(p, deepLabel.id);
  await sleep(300);
  const deepRow = await p.getByTestId("overrides-row").textContent();
  check("a deep layer shows its changes", /Fill/.test(deepRow) && /Text/.test(deepRow), deepRow);
  d = await doc(p);
  check("the override lives on the outer instance", Object.keys(named(d, "Card A").instance.overrides).includes(named(d, "Label", deepBuy.id).masterId));
  await p.getByTestId("overrides-reset").click();
  await pickItem(p, "Reset fill");
  d = await doc(p);
  check("resetting the deep fill through the outer instance keeps the deep text", fillOf(named(d, "Label", deepBuy.id)) === "#FFFFFF" && named(d, "Label", deepBuy.id).text.characters === "Deep");
  check("the outer instance's other layers are untouched", named(d, "Title", cardA.id).text.characters === "Pro plan");
  await undo(p);
  d = await doc(p);
  check("one undo restores the deep fill", fillOf(named(d, "Label", deepBuy.id)) === "#123456");
  await redo(p);

  // ---- swapped nested instance
  await dispatch(p, { op: "swapComponent", id: deepBuy.id, componentId: alt });
  d = await doc(p);
  const swappedLabel = named(d, "Label", deepBuy.id);
  await dispatch(p, { op: "update", ids: [swappedLabel.id], patch: { fills: [{ type: "solid", color: "#ff00ff" }] } });
  await sel(p, swappedLabel.id);
  await sleep(300);
  check("a layer of a swapped instance shows its change", /Fill/.test(await p.getByTestId("overrides-row").textContent()));
  await p.getByTestId("overrides-reset").click();
  await pickItem(p, "Reset fill");
  d = await doc(p);
  check("it resets to the swapped-to component's fill", fillOf(named(d, "Label", deepBuy.id)) === "#FEF3C7", fillOf(named(d, "Label", deepBuy.id)));
  check("the swap and the text stay", d.nodes[deepBuy.id].instance.componentId === alt && named(d, "Label", deepBuy.id).text.characters === "Deep");
  await dispatch(p, { op: "swapComponent", id: deepBuy.id, componentId: btn });

  // ---- R-U2: second double-click inside a nested instance opens the text editor
  await sel(p, []);
  await fit(p);
  d = await doc(p);
  const dl = named(d, "Label", named(d, "Buy", cardA.id).id);
  await clickNode(p, dl);
  await sleep(150);
  await clickNode(p, dl, { dbl: true });
  await sleep(250);
  const afterFirst = await p.locator(".text-editor").count();
  await clickNode(p, dl, { dbl: true });
  await sleep(300);
  check("the second double-click inside a nested instance opens the text editor", (await p.locator(".text-editor").count()) === 1, `after the first: ${afterFirst}`);
  await p.keyboard.press("Escape");
  await sleep(200);
  await sel(p, []);

  // ---- restore main component: the delete toast, the panel button, the context menu
  d = await doc(p);
  const keepText = named(d, "Label", solo.id);
  await dispatch(p, { op: "update", ids: [keepText.id], patch: { text: { characters: "Buy now" } } });
  await sel(p, btn);
  await sleep(200);
  d = await doc(p);
  const expected = nodes(d).filter((n) => n.instance?.componentId === btn && !(() => {
    for (let a = n.parent ? d.nodes[n.parent] : null; a; a = a.parent ? d.nodes[a.parent] : null) if (a.type === "instance") return true;
    return false;
  })()).length;
  await clickNode(p, named(d, "Button"), { dy: 4, dx: 4 });
  check("the main component is selected for deleting", (await selection(p)).includes(btn));
  await p.keyboard.press("Delete");
  await sleep(300);
  const t = await toastText(p);
  check("deleting a main toasts the instance count", /Deleted main component “Button”/.test(t) && new RegExp(`${expected} instances keep their look`).test(t) && /restore/.test(t), `${t}  (expected ${expected})`);
  await shot(p, "delete-toast");
  d = await doc(p);
  check("the main is gone and nothing else was asked", !d.nodes[btn]);
  await sel(p, solo.id);
  await sleep(300);
  check("the instance panel says the main was deleted", (await p.getByText("Main component deleted").count()) === 1 && (await p.getByTestId("restore-main").count()) === 1);
  check("the panel says what can't be restored", /Component properties and variant sets can't be restored/.test(await pageText(p)));
  check("no swap picker or reset menu for a missing main", (await p.getByTitle("Swap instance").count()) === 0 && (await p.getByTestId("instance-reset").count()) === 0);
  await shot(p, "main-missing-panel");
  await p.getByTestId("restore-main").click();
  await sleep(400);
  d = await doc(p);
  check("restoring brings back a main with the old id", d.nodes[btn]?.type === "component", d.nodes[btn]?.type);
  check("the restored main is selected", (await selection(p)).join() === btn);
  const rt = await toastText(p);
  check("the restore toast says what wasn't restored", /Restored “Solo”/.test(rt) && /can't be restored/.test(rt), rt);
  check("every instance points at the restored main again", nodes(d).filter((n) => n.instance?.componentId === btn).length >= expected);
  check("their overrides are intact", named(d, "Label", solo.id).text.characters === "Buy now" && named(d, "Label", deepBuy.id).text.characters === "Deep");
  check("the main's layers have their old ids", !!named(d, "Label", btn) && named(d, "Label", solo.id).masterId === named(d, "Label", btn).id);
  check("the restored main is its own layer, not inside an instance", d.nodes[btn].parent === null);
  await shot(p, "restored");
  // one undo removes it
  await undo(p);
  d = await doc(p);
  check("one undo removes the restored main", !d.nodes[btn] && !nodes(d).some((n) => n.type === "component" && n.name === "Button"));
  // context menu
  await fit(p);
  await clickNode(p, named(d, "Solo"), { button: "right" });
  await sleep(250);
  const rm = await items(p);
  check("the canvas menu offers Restore main component", rm.includes("Restore main component") && !rm.includes("Reset all overrides"), rm.join(" | ").slice(0, 300));
  await pickItem(p, "Restore main component");
  d = await doc(p);
  check("it restores", d.nodes[btn]?.type === "component" && named(d, "Label", solo.id).text.characters === "Buy now");

  // ---- R-U1: naming on a component, a set and a variant
  await sel(p, btn);
  await sleep(300);
  const plain = await pageText(p);
  check("a plain component keeps 'Properties' and its empty text", /PropertiesNo properties yet/.test(plain) && !/Component properties/.test(plain) && /No properties yet/.test(plain));
  const vs = await tool(p, "create_nodes", {
    nodes: [
      { type: "component", name: "State=Default", x: 0, y: 500, width: 100, height: 40, fill: "#222222" },
      { type: "component", name: "State=Hover", x: 140, y: 500, width: 100, height: 40, fill: "#444444" },
    ],
  });
  const vids = vs.result.created.map((c) => c.id);
  await sel(p, vids);
  await dispatch(p, { op: "combineVariants", ids: vids });
  await sleep(300);
  d = await doc(p);
  const setNode = nodes(d).find((n) => n.type === "componentSet");
  await sel(p, setNode.id);
  await sleep(300);
  const setText = await pageText(p);
  check("a component set says 'Component properties'", /Component properties/.test(setText));
  check("and its empty state points at the variant properties", /Variant properties are above\. Add Boolean, Text or Instance swap properties here/.test(setText));
  await shot(p, "set-panel");
  await sel(p, vids[0]);
  await sleep(300);
  check("a variant says 'Component properties' too", /Component properties/.test(await pageText(p)));

  check("no page errors so far", errors.length === 0, errors.slice(0, 3).join(" | "));

  // ---- collab: a reset and a restore reach the other person
  if (BRIDGE) {
    const octx = await newCtx();
    const owner = await open(octx, BRIDGE);
    const ids = await build(owner);
    let od = await doc(owner);
    const os = named(od, "Solo");
    await dispatch(owner, { op: "update", ids: [named(od, "Label", os.id).id], patch: { text: { characters: "Host text" }, fills: [{ type: "solid", color: "#ff0000" }] } });
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
    await guest.waitForFunction(() => Object.values(window.__dt.doc().nodes).some((n) => n.name === "Solo"), null, { timeout: 8000 });
    const gl = () => doc(guest).then((g) => named(g, "Label", named(g, "Solo").id));
    check("the guest sees the host's overrides", (await gl()).text.characters === "Host text" && fillOf(await gl()) === "#FF0000");
    // the guest resets the fill from its own panel
    await sel(guest, (await gl()).id);
    await sleep(300);
    await guest.getByTestId("overrides-reset").click();
    await pickItem(guest, "Reset fill");
    await owner.waitForFunction((id) => (window.__dt.doc().nodes[id].fills[0]?.color ?? "").toUpperCase() === "#FFFFFF", named(od, "Label", os.id).id, { timeout: 8000 }).catch(() => {});
    od = await doc(owner);
    const oLabel = named(od, "Label", os.id);
    check("the host gets the reset as a normal change", fillOf(oLabel) === "#FFFFFF" && oLabel.text.characters === "Host text", fillOf(oLabel));
    check("both sides hold the same override record", JSON.stringify(od.nodes[os.id].instance.overrides) === JSON.stringify((await doc(guest)).nodes[os.id].instance.overrides));
    // the host deletes the main; the guest restores it
    await sel(owner, ids.btn);
    await owner.keyboard.press("Delete");
    await guest.waitForFunction((b) => !window.__dt.doc().nodes[b], ids.btn, { timeout: 8000 }).catch(() => {});
    check("the delete reaches the guest", !(await doc(guest)).nodes[ids.btn]);
    await sel(guest, os.id);
    await sleep(300);
    check("the guest's instance offers Restore main component", (await guest.getByTestId("restore-main").count()) === 1);
    await guest.getByTestId("restore-main").click();
    await owner.waitForFunction((b) => !!window.__dt.doc().nodes[b], ids.btn, { timeout: 8000 }).catch(() => {});
    od = await doc(owner);
    check("the host gets the restored main with its old id", od.nodes[ids.btn]?.type === "component", od.nodes[ids.btn]?.type);
    check("the host's instance points at it with the text override", od.nodes[os.id].instance.componentId === ids.btn && named(od, "Label", os.id).text.characters === "Host text");
    const gd = await doc(guest);
    check("both documents agree on the restored subtree", JSON.stringify(subtree(od, ids.btn)) === JSON.stringify(subtree(gd, ids.btn)) && subtree(od, ids.btn).length === 2);
    await undo(guest);
    await owner.waitForFunction((b) => !window.__dt.doc().nodes[b], ids.btn, { timeout: 8000 }).catch(() => {});
    check("undoing the restore removes the main on the host", !(await doc(owner)).nodes[ids.btn]);
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
