// Export rows, copy as PNG/SVG/CSS, copy/paste properties and paste to replace.
// Usage: start `npm run dev` (port 5173), then `node scripts/qa/w2e-e2e.mjs`.
// Env: E2E_URL (default http://localhost:5173), CHROMIUM (executable path).

import { chromium } from "playwright-core";
import JSZip from "jszip";
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
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
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
const nodes = async () => Object.values((await doc()).nodes);
const byName = async (name) => (await nodes()).find((n) => n.name === name);
const named = async (name) => (await nodes()).filter((n) => n.name === name);
const select = async (...names) => {
  const ids = [];
  for (const name of names) ids.push((await byName(name)).id);
  await page.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), ids);
  await page.waitForTimeout(150);
};
const blurFocus = () => page.evaluate(() => document.activeElement && document.activeElement.blur());
const key = async (combo) => {
  await blurFocus();
  await page.keyboard.press(combo);
  await page.waitForTimeout(250);
};
const exportSection = () => page.locator(".section", { has: page.locator(".section-head", { hasText: "Export" }) });
const pngSize = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
const clipboardTypes = () =>
  page.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => i.types));
const clipboardPng = () =>
  page.evaluate(async () => {
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes("image/png")) {
        const bytes = new Uint8Array(await (await item.getType("image/png")).arrayBuffer());
        const v = new DataView(bytes.buffer);
        return { w: v.getUint32(16), h: v.getUint32(20), size: bytes.length };
      }
    }
    return null;
  });
const clipboardText = () => page.evaluate(() => navigator.clipboard.readText());
/** Right-clicks a layer on the canvas and picks a context menu item. */
async function menu(name, label) {
  const n = await byName(name);
  const box = await page.evaluate((id) => {
    const r = document.querySelector(`#dt-canvas [data-id='${id}']`).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, n.id);
  await page.mouse.click(box.x, box.y, { button: "right" });
  await page.waitForTimeout(150);
  await page.locator(".menu button, .menu .item, .menu div", { hasText: new RegExp(`^${label}`) }).last().click();
  await page.waitForTimeout(400);
}

try {
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 20000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.evaluate(() =>
    window.__dt.tool("create_nodes", {
      parentId: null,
      nodes: [
        { type: "rectangle", name: "Card", x: 0, y: 0, width: 200, height: 100, fill: "#3366FF", cornerRadius: 12 },
        { type: "rectangle", name: "Styled", x: 300, y: 0, width: 80, height: 60, fill: "#FF0000", stroke: "#00AA00", strokeWidth: 4, cornerRadius: 10, opacity: 0.5, shadow: { x: 0, y: 4, blur: 8, color: "#00000080" } },
        { type: "rectangle", name: "Plain", x: 300, y: 200, width: 120, height: 90, fill: "#CCCCCC" },
        { type: "text", name: "Big", text: "Big", x: 500, y: 0, fontSize: 40, fontWeight: 700, fontFamily: "Inter", fill: "#112233" },
        { type: "text", name: "Small", text: "Small", x: 500, y: 100, fontSize: 12, fontWeight: 400, fontFamily: "Inter", fill: "#999999" },
        {
          type: "frame",
          name: "Row",
          x: 0,
          y: 400,
          width: 400,
          height: 100,
          fill: "#FFFFFF",
          children: [
            { type: "rectangle", name: "First", x: 10, y: 10, width: 30, height: 30, fill: "#111111" },
            { type: "rectangle", name: "Victim", x: 60, y: 20, width: 50, height: 40, fill: "#AAAAAA" },
            { type: "rectangle", name: "Last", x: 140, y: 10, width: 30, height: 30, fill: "#222222" },
          ],
        },
      ],
    }),
  );
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__dt.zoomToFit());

  // 1. Three export rows on one layer: +, +, then per-row settings (size, format, suffix).
  await select("Card");
  let sec = exportSection();
  check("a layer with no rows shows one default row", (await sec.locator("select").count()) === 2);
  await sec.locator("button[title='Add export setting']").click();
  await sec.locator("button[title='Add export setting']").click();
  await page.waitForTimeout(200);
  let card = await byName("Card");
  check("+ saves rows on the layer", (card.exportSettings ?? []).length === 3, JSON.stringify(card.exportSettings));
  sec = exportSection();
  const rows = sec.locator(".export-row");
  check("three rows are listed", (await rows.count()) === 3);
  // Row 1: PNG, fixed width 512. Row 2: JPG 2x with a suffix.
  await rows.nth(1).locator("select").first().selectOption({ label: "Width" });
  await page.waitForTimeout(150);
  await rows.nth(1).locator("input").first().fill("512");
  await rows.nth(1).locator("input").first().press("Enter");
  await page.waitForTimeout(150);
  await rows.nth(2).locator("select").last().selectOption({ label: "JPG" });
  await rows.nth(2).locator("select").first().selectOption({ label: "2x" });
  await rows.nth(2).locator("input[title='File name suffix']").fill("-big");
  await rows.nth(2).locator("input[title='File name suffix']").press("Enter");
  await page.waitForTimeout(250);
  card = await byName("Card");
  const s = card.exportSettings;
  check(
    "rows hold scale, fixed width, format and suffix",
    s.length === 3 && s[0].scale === 1 && s[1].width === 512 && s[1].format === "png" && s[2].format === "jpg" && s[2].scale === 2 && s[2].suffix === "-big",
    JSON.stringify(s),
  );

  // 2. "Export Card" writes all three files (zipped), with the right suffixes and sizes.
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), exportSection().locator("button.btn").click()]);
  const zip = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
  const names = Object.keys(zip.files).sort();
  check("one click exports every row as a zip", dl.suggestedFilename() === "Card.zip" && names.length === 3, `${dl.suggestedFilename()} ${names.join(", ")}`);
  check("names: Card.png, Card@512w.png, Card-big.jpg", names.join(",") === "Card-big.jpg,Card.png,Card@512w.png", names.join(","));
  const sz = async (n) => pngSize(Buffer.from(await zip.files[n].async("uint8array")));
  const a = await sz("Card.png");
  const b = await sz("Card@512w.png");
  check("1x is 200x100 and width 512 gives 512x256", a.w === 200 && a.h === 100 && b.w === 512 && b.h === 256, JSON.stringify({ a, b }));
  const jpg = Buffer.from(await zip.files["Card-big.jpg"].async("uint8array"));
  // JPEG: scan for the SOF0/SOF2 marker for the height and width.
  let jw = 0, jh = 0;
  for (let i = 2; i < jpg.length - 9; i++) {
    if (jpg[i] === 0xff && (jpg[i + 1] === 0xc0 || jpg[i + 1] === 0xc2)) {
      jh = jpg.readUInt16BE(i + 5);
      jw = jpg.readUInt16BE(i + 7);
      break;
    }
  }
  check("2x JPG is 400x200", jw === 400 && jh === 200, `${jw}x${jh}`);

  // A fixed height row, and one row alone downloads a plain file.
  await rows.nth(1).locator("select").first().selectOption({ label: "Height" });
  await page.waitForTimeout(150);
  await rows.nth(1).locator("input").first().fill("300");
  await rows.nth(1).locator("input").first().press("Enter");
  await page.waitForTimeout(200);
  card = await byName("Card");
  check("a row can switch to a fixed height", card.exportSettings[1].height === 300 && !card.exportSettings[1].width, JSON.stringify(card.exportSettings[1]));
  await rows.nth(2).locator("button[title='Remove export setting']").click();
  await rows.nth(1).locator("button[title='Remove export setting']").click();
  await page.waitForTimeout(200);
  card = await byName("Card");
  check("- removes a row", card.exportSettings.length === 1, JSON.stringify(card.exportSettings));
  const [one] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), exportSection().locator("button.btn").click()]);
  check("a single file downloads without a zip", one.suggestedFilename() === "Card.png", one.suggestedFilename());
  // Re-add two rows for the persistence check.
  await exportSection().locator("button[title='Add export setting']").click();
  await exportSection().locator("button[title='Add export setting']").click();
  await page.waitForTimeout(200);
  card = await byName("Card");
  check("the layer keeps 3 rows", card.exportSettings.length === 3);

  // 3. Settings survive a reload (autosave) and travel with the layer.
  await page.waitForTimeout(2500);
  const fileUrl = page.url();
  await page.reload();
  await page.waitForSelector("#dt-canvas", { timeout: 20000 });
  await page.waitForTimeout(800);
  const reCard = await byName("Card");
  check("export rows survive a reload", (reCard?.exportSettings ?? []).length === 3, `${fileUrl} ${JSON.stringify(reCard?.exportSettings)}`);

  // 4. Copy as PNG / SVG / CSS from the context menu.
  await page.evaluate(() => window.__dt.zoomToFit());
  await select("Card");
  await menu("Card", "Copy as PNG");
  const types = await clipboardTypes();
  const png = await clipboardPng();
  check("Copy as PNG puts an image/png in the clipboard", types.includes("image/png") && !!png && png.w === 400 && png.h === 200, JSON.stringify({ types, png }));
  await select("Card");
  await menu("Card", "Copy as SVG");
  const svgText = await clipboardText();
  check("Copy as SVG puts SVG text in the clipboard", /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svgText) && svgText.includes("</svg>"), svgText.slice(0, 60));
  await select("Card");
  await menu("Card", "Copy as CSS");
  const css = await clipboardText();
  check("Copy as CSS puts the layer's CSS in the clipboard", /^\.card \{[\s\S]*width: 200px;[\s\S]*\}$/.test(css), css.replace(/\n/g, " ").slice(0, 120));

  // 5. Copy / paste properties (Ctrl+Alt+C / Ctrl+Alt+V), one undo step.
  const look = (n) => JSON.stringify({ f: n.fills, s: n.strokes, w: n.strokeWeight, r: n.cornerRadius, o: n.opacity, e: n.effects });
  const before = await byName("Plain");
  await select("Styled");
  await key("Control+Alt+c");
  await select("Plain");
  await key("Control+Alt+v");
  const styled = await byName("Styled");
  const plain = await byName("Plain");
  check("pasted properties copy fills, strokes, radius, opacity and effects", look(styled) === look(plain), look(plain));
  check("paste properties keeps size and position", plain.width === before.width && plain.height === before.height && plain.x === before.x && plain.y === before.y);
  await key("Control+z");
  const undone = await byName("Plain");
  check("paste properties is one undo step", look(undone) === look(before), look(undone));
  // Text style properties go to text layers only; the characters stay.
  await select("Big");
  await key("Control+Alt+c");
  await select("Small", "Plain");
  await key("Control+Alt+v");
  const small = await byName("Small");
  check("text properties paste onto text (size, weight, colour), characters unchanged", small.text.fontSize === 40 && small.text.fontWeight === 700 && small.text.characters === "Small" && JSON.stringify(small.fills) === JSON.stringify((await byName("Big")).fills), JSON.stringify({ fs: small.text.fontSize, fw: small.text.fontWeight }));
  await key("Control+z");
  check("one undo reverts text and shape together", (await byName("Small")).text.fontSize === 12 && look(await byName("Plain")) === look(before));

  // 6. Paste to replace (Ctrl+Shift+R): keeps parent, place in the stack and top-left corner.
  const victim = await byName("Victim");
  const row = await byName("Row");
  const order = (await byName("Row")).children;
  await select("Styled");
  await key("Control+c");
  await select("Victim");
  await key("Control+Shift+r");
  const after = await doc();
  const gone = !after.nodes[victim.id];
  const copies = Object.values(after.nodes).filter((n) => n.name === "Styled" && n.id !== styled.id);
  const copy = copies[0];
  const rowAfter = after.nodes[row.id];
  check("paste to replace removes the selected layer", gone);
  check("the clipboard layer takes its parent and stack position", !!copy && copy.parent === row.id && rowAfter.children.indexOf(copy.id) === order.indexOf(victim.id) && rowAfter.children.length === order.length, JSON.stringify({ parent: copy?.parent, kids: rowAfter.children.length }));
  check("and its top-left corner", !!copy && Math.abs(copy.x - victim.x) < 0.01 && Math.abs(copy.y - victim.y) < 0.01, `${copy?.x},${copy?.y} vs ${victim.x},${victim.y}`);
  check("the replacement is selected", JSON.stringify((await page.evaluate(() => window.__dt.state().selection))) === JSON.stringify([copy?.id]));
  await key("Control+z");
  const back = await doc();
  check("undo brings the original back in one step", !!back.nodes[victim.id] && !Object.values(back.nodes).some((n) => n.name === "Styled" && n.id !== styled.id) && JSON.stringify(back.nodes[row.id].children) === JSON.stringify(order));

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
  check("unexpected exception", false, String(err));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
