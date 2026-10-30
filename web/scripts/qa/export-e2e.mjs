// Export and paste correctness: export bounds, oversized exports, SVG paste with an XML prolog,
// SVG export without a scale, colour styles from gradients, `*/` in developer notes.
// Usage: start `npm run dev` (port 5173), then `node scripts/qa/export-e2e.mjs`.
// Env: E2E_URL (default http://localhost:5173), CHROMIUM (executable path).

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" };

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
// Fonts are fetched from Google when an SVG is exported; keep the test off the internet.
await context.route(
  (u) => !/^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) && !/^(data|blob):/.test(u.toString()),
  (r) => r.abort(),
);
const page = await context.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const doc = () => page.evaluate(() => window.__dt.doc());
const byName = async (name) => Object.values(await doc().then((d) => d.nodes)).find((n) => n.name === name);
const select = async (name) => {
  const n = await byName(name);
  await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), n.id);
  await page.waitForTimeout(150);
};
const exportSection = () => page.locator(".section", { has: page.locator(".section-head", { hasText: "Export" }) });
const toasts = () => page.locator(".toast").allInnerTexts();

/** Exports the selection from the panel and returns the file name and its bytes. */
async function exportSelected(format, scale) {
  const sec = exportSection();
  if (scale !== undefined) await sec.locator("select").first().selectOption({ label: `${scale}x` });
  await sec.locator("select").last().selectOption({ label: format });
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), sec.locator("button.btn").click()]);
  const path = await dl.path();
  return { name: dl.suggestedFilename(), bytes: fs.readFileSync(path) };
}

const pngSize = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

try {
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 20000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.evaluate(() =>
    window.__dt.tool("create_nodes", {
      parentId: null,
      nodes: [
        { type: "rectangle", name: "Outside", x: 100, y: 100, width: 100, height: 60, fill: "#E0E7FF", stroke: "#4F46E5", strokeWidth: 10, strokeAlign: "outside" },
        { type: "rectangle", name: "Shadowed", x: 300, y: 100, width: 100, height: 60, fill: "#FFFFFF", shadow: { x: 0, y: 12, blur: 20, color: "#00000080" } },
        { type: "frame", name: "Wide", x: 0, y: 400, width: 20000, height: 100, fill: "#E5E7EB" },
        { type: "rectangle", name: "Grad", x: 600, y: 100, width: 80, height: 80, fill: "#3366FF" },
      ],
    }),
  );
  await page.waitForTimeout(300);

  // 1. Export bounds include outside strokes and shadows (before: 100x60 for both).
  await select("Outside");
  let r = await exportSelected("PNG", 1);
  check("outside stroke is inside the PNG", JSON.stringify(pngSize(r.bytes)) === '{"w":120,"h":80}', JSON.stringify(pngSize(r.bytes)));
  await select("Shadowed");
  r = await exportSelected("PNG", 1);
  check("shadow is inside the PNG", JSON.stringify(pngSize(r.bytes)) === '{"w":140,"h":100}', JSON.stringify(pngSize(r.bytes)));

  // 2. SVG export: no scale picker, and the SVG has the padded size.
  await select("Outside");
  r = await exportSelected("SVG");
  check("SVG export hides the scale picker", (await exportSection().locator("select").count()) === 1);
  check("SVG export is cropped to the stroke", /width="120" height="80"/.test(r.bytes.toString()) && r.name === "Outside.svg", r.name);
  await exportSection().locator("select").last().selectOption({ label: "PNG" });
  check("scale picker returns for PNG", (await exportSection().locator("select").count()) === 2);

  // 3. A raster wider than the browser limit is scaled down, with a toast, not dropped.
  await select("Wide");
  r = await exportSelected("PNG", 1);
  const s = pngSize(r.bytes);
  check("oversized export is clamped to 16384 px", s.w <= 16384 && s.w > 16000 && s.h > 0, `${s.w}x${s.h} ${r.name}`);
  check("clamped export says so", (await toasts()).some((t) => /too large/.test(t)), JSON.stringify(await toasts()));

  // 4. SVG text with an XML prolog, DOCTYPE and comment pastes as an image layer, not text.
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#F59E0B"/></svg>`;
  const prolog = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by an editor -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${SVG}`;
  const before = Object.keys((await doc()).nodes).length;
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, prolog);
  await page.waitForTimeout(600);
  const added = Object.values((await doc()).nodes).filter((n) => n.name === "SVG");
  check("SVG with XML prolog pastes as an image", added.length === 1 && added[0].type !== "text" && added[0].width === 120, `${before} -> ${Object.keys((await doc()).nodes).length}`);

  // 5. A colour style can't be made from a gradient.
  const grad = await byName("Grad");
  await page.evaluate(
    (id) =>
      window.__dt.dispatch({
        op: "update",
        ids: [id],
        patch: { fills: [{ type: "linearGradient", angle: 90, opacity: 1, visible: true, stops: [{ color: "#FF0000", position: 0 }, { color: "#0000FF", position: 1 }] }] },
      }),
    grad.id,
  );
  await select("Grad");
  await page.locator("text=Assets").first().click();
  const styles = async () => (await doc()).styles.colors.length;
  const n0 = await styles();
  await page.locator("[title='Create colour style from selection']").first().click();
  await page.waitForTimeout(300);
  check("gradient fill: no colour style is made", (await styles()) === n0, `${n0} -> ${await styles()}`);
  check("gradient fill: a toast explains why", (await toasts()).some((t) => /single solid colour/.test(t)), JSON.stringify(await toasts()));
  await select("Outside");
  await page.locator("[title='Create colour style from selection']").first().click();
  await page.waitForTimeout(300);
  check("solid fill still makes a colour style", (await styles()) === n0 + 1);

  // 6. A note containing */ doesn't break out of the CSS comment.
  await page.locator("text=Layers").first().click();
  await select("Outside");
  await page.evaluate(() => window.__dt.dispatch({ op: "update", ids: [Object.values(window.__dt.doc().nodes).find((n) => n.name === "Outside").id], patch: { notes: "Hover */ check" } }));
  await page.click(".tab:has-text('Code')");
  await page.waitForTimeout(300);
  await page.locator(".scroll select").first().selectOption({ label: "CSS (this layer)" });
  const css = await page.locator(".code-block").innerText();
  check("notes with */ stay inside the comment", css.startsWith("/* Hover * / check */") && (css.match(/\*\//g) ?? []).length === 1, css.split("\n")[0]);

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
  check("unexpected exception", false, String(err));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
