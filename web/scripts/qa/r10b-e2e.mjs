// Round 10, P2 (design-system workflow): pasting layers into another file brings the variables and
// styles they use (toast, no "Missing variable", Dark pin kept), mode delete asks first and drops the
// values, the variables dialog refuses a colour that is no colour and a duplicate name, and a paste
// in a shared room reaches the peer with its variables and styles.
// Usage: dev server (or the bridge serving web/dist), then
//   cd web && E2E_URL=http://127.0.0.1:5641 node scripts/qa/r10b-e2e.mjs       Screenshots: E2E_OUT.
// Collab part: E2E_BRIDGE=http://127.0.0.1:5642 (a bridge serving web/dist, LAN share on port+1).
// Every non-local request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL_ = process.env.E2E_URL ?? "http://127.0.0.1:5641";
const BRIDGE = process.env.E2E_BRIDGE ?? "";
const OUT = process.env.E2E_OUT ?? "/tmp/r10b-shots";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
};
const local = (u) => ["localhost", "127.0.0.1"].includes(new URL(u).hostname) || /^(192\.0\.2|10|192\.168)\./.test(new URL(u).hostname);

if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1,192.0.2.2,10.*,192.168.*,172.16.*" };
const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(URL_).origin });
await context.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* sandboxed frames have no storage */
  }
});
await context.route("**/*", (route) => (local(route.request().url()) || route.request().url().startsWith("data:") || route.request().url().startsWith("blob:") ? route.continue() : route.abort()));

const errors = [];
const open = async (ctx = context, url = URL_) => {
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
const toastText = (p) => p.locator(".toast").first().textContent({ timeout: 1500 }).catch(() => "");
const toastGone = (p) => p.waitForSelector(".toast", { state: "detached", timeout: 9000 }).catch(() => {});
const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

/** Primitives, a Theme aliasing it with Light/Dark, three styles, and a Dark-pinned screen using them. */
async function buildSystem(p) {
  await tool(p, "define_variables", {
    collection: "Primitives",
    variables: [
      { name: "Gray/0", type: "color", value: "#FFFFFF" },
      { name: "Gray/900", type: "color", value: "#101828" },
    ],
  });
  await tool(p, "define_variables", {
    collection: "Theme",
    modes: ["Light", "Dark"],
    variables: [
      { name: "Surface", type: "color", values: { Light: { alias: "Primitives/Gray/0" }, Dark: { alias: "Primitives/Gray/900" } } },
      { name: "Ink", type: "color", values: { Light: "#101828", Dark: "#F9FAFB" } },
    ],
  });
  await tool(p, "define_styles", {
    colors: [{ name: "Brand", color: "#6D4AFF" }],
    texts: [{ name: "Body/Large", fontSize: 18, fontWeight: 500 }],
    effects: [{ name: "Card", shadow: { y: 4, blur: 12 } }],
  });
  const r = await tool(p, "create_nodes", {
    nodes: [
      {
        type: "frame", name: "Dark screen", x: 0, y: 0, width: 320, height: 240, bind: { fill: "Theme/Surface" }, variableModes: { Theme: "Dark" },
        children: [
          { type: "text", name: "Title", text: "Hello", x: 20, y: 20, textStyle: "Body/Large", bind: { fill: "Theme/Ink" } },
          { type: "rectangle", name: "Card", x: 20, y: 80, width: 120, height: 80, fillStyle: "Brand", effectStyle: "Card" },
        ],
      },
    ],
  });
  return r.result.created[0].id;
}

const hexOf = (n) => (n.fills?.[0]?.color ?? "").toUpperCase();

try {
  // ---- copy from file A, paste into a new file B in the same browser context
  const a = await open();
  const screen = await buildSystem(a);
  const clip = await a.evaluate((id) => window.__dt.query({ q: "copy", ids: [id] }), screen);
  const parsed = JSON.parse(clip);
  check("copy carries the variables and the styles", parsed.variables?.length === 2 && parsed.styles?.colors?.length === 1 && parsed.styles?.texts?.length === 1 && parsed.styles?.effects?.length === 1,
    JSON.stringify({ v: parsed.variables?.map((c) => c.name), s: Object.keys(parsed.styles ?? {}) }));

  const b = await open();
  await b.evaluate((t) => navigator.clipboard.writeText(t), clip);
  await b.bringToFront();
  // The empty file's prompt box holds focus (and the paste); focus the canvas instead.
  await b.evaluate(() => document.activeElement?.blur());
  await b.locator("#dt-canvas").click({ position: { x: 700, y: 650 } });
  await b.keyboard.press("Control+V");
  await b.waitForTimeout(700);
  const tt = await toastText(b);
  check("the paste toast says what was added", /Added .*variable.*style.* from the copied layers/.test(tt), tt);
  const db = await doc(b);
  const theme = db.variables.find((c) => c.name === "Theme");
  check("B has Theme with its two modes and Primitives", theme?.modes.length === 2 && db.variables.some((c) => c.name === "Primitives"), JSON.stringify(db.variables.map((c) => [c.name, c.modes.map((m) => m.name)])));
  const pasted = Object.values(db.nodes).find((n) => n.name === "Dark screen");
  const dark = theme?.modes.find((m) => m.name === "Dark");
  check("the pasted screen keeps its Dark pin on B's Theme", pasted?.variableModes?.[theme?.id] === dark?.id, JSON.stringify(pasted?.variableModes));
  check("its fill resolves to the Dark value through the alias", hexOf(pasted) === "#101828", hexOf(pasted));
  const title = Object.values(db.nodes).find((n) => n.name === "Title");
  const style = db.styles.texts.find((s) => s.id === title?.textStyle);
  check("the text keeps its text style", style?.name === "Body/Large" && style?.fontSize === 18, JSON.stringify(style));
  const card = Object.values(db.nodes).find((n) => n.name === "Card");
  check("colour and effect styles are linked", db.styles.colors.find((s) => s.id === card?.fillStyle)?.name === "Brand" && db.styles.effects.find((s) => s.id === card?.effectStyle)?.name === "Card");
  const bound = [pasted, title].every((n) => Object.values(n.bindings ?? {}).every((v) => db.variables.some((c) => c.variables.some((x) => x.id === v))));
  check("every binding points at a variable that exists in B", bound);
  // Selecting the title shows the style chip, and the variables dialog shows no missing variable.
  await b.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id], mode: "replace" }), title.id);
  await b.waitForTimeout(300);
  check("the text style chip shows in the Design panel", (await b.locator("text=Body/Large").count()) > 0);
  await shot(b, "paste-into-new-file");
  await b.evaluate(() => window.__dt.dispatch({ op: "select", ids: [], mode: "replace" }));
  await b.getByRole("button", { name: /Open variables/ }).first().click();
  await b.waitForSelector(".variables-dialog");
  check("the variables dialog shows no missing variable", (await b.locator("[data-alias=missing]").count()) === 0 && (await b.locator("text=Missing variable").count()) === 0);
  await shot(b, "variables-in-b");
  await b.keyboard.press("Escape");

  // Pasting the same clip again, and pasting into the file it came from, add nothing.
  const countsB = (d) => `${d.variables.length}/${d.variables.flatMap((c) => c.variables).length}/${d.styles.colors.length + d.styles.texts.length + d.styles.effects.length}`;
  const before = countsB(await doc(b));
  await toastGone(b);
  await b.locator("#dt-canvas").click({ position: { x: 700, y: 650 } });
  await b.keyboard.press("Control+V");
  await b.waitForTimeout(500);
  check("a second paste reuses the tokens (no duplicates, no toast)", countsB(await doc(b)) === before && !/Added/.test(await toastText(b)), `${before} -> ${countsB(await doc(b))}`);
  const aBefore = countsB(await doc(a));
  await a.bringToFront();
  await toastGone(a);
  await a.evaluate((t) => navigator.clipboard.writeText(t), clip);
  await a.locator("#dt-canvas").click({ position: { x: 900, y: 600 } });
  await a.keyboard.press("Control+V");
  await a.waitForTimeout(500);
  check("pasting in the same file adds nothing", countsB(await doc(a)) === aBefore && !/Added/.test(await toastText(a)), `${aBefore} -> ${countsB(await doc(a))}`);

  // ---- mode delete asks first and drops the values
  await a.getByRole("button", { name: /Open variables/ }).first().click().catch(async () => {
    await a.evaluate(() => window.__dt.dispatch({ op: "select", ids: [], mode: "replace" }));
    await a.getByRole("button", { name: /Open variables/ }).first().click();
  });
  await a.waitForSelector(".variables-dialog");
  await a.locator(".var-coll", { hasText: "Theme" }).click();
  await a.locator("button[aria-label='Delete mode Dark']").click();
  await a.waitForSelector("[role=alertdialog]");
  const msg = await a.locator("[role=alertdialog] .confirm-body").textContent();
  check("mode delete asks, with what happens to pinned layers", /pinned to it/.test(msg) && /2 variables/.test(msg), msg);
  await shot(a, "mode-delete-confirm");
  await a.locator("[role=alertdialog] button:has-text('Cancel')").click();
  let da = await doc(a);
  check("Cancel keeps the mode", da.variables.find((c) => c.name === "Theme").modes.length === 2);
  await a.locator("button[aria-label='Delete mode Dark']").click();
  await a.locator("[role=alertdialog] button:has-text('Delete mode')").click();
  await a.waitForTimeout(400);
  da = await doc(a);
  const ta = da.variables.find((c) => c.name === "Theme");
  const darkId = parsed.variables.find((c) => c.name === "Theme").modes.find((m) => m.name === "Dark").id;
  check("the mode is gone with its values", ta.modes.length === 1 && ta.variables.every((v) => Object.keys(v.values).length === 1 && !(darkId in v.values)), JSON.stringify(ta.variables.map((v) => Object.keys(v.values))));
  const aScreen = da.nodes[screen];
  check("the pin to the deleted mode is dropped", Object.keys(aScreen.variableModes ?? {}).length === 0, JSON.stringify(aScreen.variableModes));

  // ---- the dialog refuses a non-colour and a duplicate name
  await a.locator(".var-coll", { hasText: "Primitives" }).click();
  const row = a.locator("tr[data-variable='Gray/900']");
  const hex = row.locator("input.mono");
  await hex.fill("banana");
  await hex.press("Enter");
  await a.waitForTimeout(300);
  check("banana is refused with a toast", /isn't a colour/.test(await toastText(a)), await toastText(a));
  await a.waitForTimeout(200);
  check("the cell goes back to the stored colour", (await hex.inputValue()) === "#101828", await hex.inputValue());
  da = await doc(a);
  check("the stored colour is unchanged", da.variables.find((c) => c.name === "Primitives").variables.find((v) => v.name === "Gray/900").values[da.variables.find((c) => c.name === "Primitives").modes[0].id] === "#101828");
  const nameInput = a.locator("tr[data-variable='Gray/900'] input.textinput").first();
  await toastGone(a);
  // The row sits in the "Gray" folder, so the name typed is the part after it.
  await nameInput.fill("0");
  await nameInput.press("Enter");
  await a.waitForTimeout(300);
  check("a duplicate name is refused with a toast", /already exists in Primitives/.test(await toastText(a)), await toastText(a));
  da = await doc(a);
  check("both variables keep their names", da.variables.find((c) => c.name === "Primitives").variables.map((v) => v.name).join() === "Gray/0,Gray/900");
  // New variables never collide: delete color 1 and add two.
  await a.getByRole("button", { name: /Create variable/ }).click();
  await a.getByRole("menuitem", { name: "Color" }).click();
  await a.getByRole("button", { name: /Create variable/ }).click();
  await a.getByRole("menuitem", { name: "Color" }).click();
  da = await doc(a);
  const names = da.variables.find((c) => c.name === "Primitives").variables.map((v) => v.name);
  check("created variables get unused names", new Set(names).size === names.length && names.length === 4, names.join());
  await shot(a, "variables-refused");
  await a.keyboard.press("Escape");

  // ---- collab: a paste in a room reaches the peer with its variables and styles
  if (BRIDGE) {
    const owner = await open(await browser.newContext({ viewport: { width: 1400, height: 900 } }).then(async (c) => {
      await c.addInitScript(() => localStorage.setItem("dt:tour-done", "1"));
      return c;
    }), BRIDGE);
    await owner.click(".tbtn[title='Share for live editing']");
    await owner.fill(".share-dialog input.textinput >> nth=0", "Olga");
    await owner.click("button:has-text('Share on this network')");
    await owner.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 10000 });
    const link = await owner.evaluate(() => window.__dt.collab().link);
    await owner.keyboard.press("Escape");
    const gctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await gctx.addInitScript(() => localStorage.setItem("dt:tour-done", "1"));
    const guest = await gctx.newPage();
    guest.on("pageerror", (e) => errors.push(String(e)));
    await guest.goto(link);
    await guest.waitForSelector("#dt-canvas");
    await guest.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 15000 });
    await guest.evaluate((t) => window.__dt.dispatch({ op: "paste", data: t, parent: null, x: 50, y: 50 }), clip);
    await owner.waitForFunction(() => Object.values(window.__dt.doc().nodes).some((n) => n.name === "Dark screen") && window.__dt.doc().variables.length === 2, null, { timeout: 8000 }).catch(() => {});
    const o = await doc(owner);
    const g = await doc(guest);
    check("the peer gets the pasted layers, variables and styles", o.variables.length === 2 && o.styles.texts.length === 1 && o.styles.colors.length === 1 && o.styles.effects.length === 1 && Object.values(o.nodes).some((n) => n.name === "Dark screen"),
      JSON.stringify({ v: o.variables.map((c) => c.name), s: [o.styles.colors.length, o.styles.texts.length, o.styles.effects.length] }));
    check("both sides hold identical tokens", JSON.stringify(o.variables) === JSON.stringify(g.variables) && JSON.stringify(o.styles) === JSON.stringify(g.styles));
    const os = Object.values(o.nodes).find((n) => n.name === "Dark screen");
    const th = o.variables.find((c) => c.name === "Theme");
    check("the peer's pin and resolved fill are right", os?.variableModes?.[th?.id] === th?.modes.find((m) => m.name === "Dark")?.id && hexOf(os) === "#101828", hexOf(os));
    await guest.evaluate(() => window.__dt.dispatch({ op: "undo" }));
    await guest.waitForFunction(() => window.__dt.doc().variables.length === 0, null, { timeout: 5000 }).catch(() => {});
    const g2 = await doc(guest);
    check("undoing the paste removes the nodes and tokens", g2.variables.length === 0 && !Object.values(g2.nodes).some((n) => n.name === "Dark screen"), JSON.stringify(g2.variables.map((c) => c.name)));
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
