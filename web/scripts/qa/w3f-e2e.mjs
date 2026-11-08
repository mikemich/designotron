// W3-F: Dev Mode style inspect in the Code tab, the full component library, no inlined images in the
// snippet, and an exported project that still compiles.
// Usage: start `npm run dev`, then `E2E_URL=http://localhost:<port> node scripts/qa/w3f-e2e.mjs`.
// Env: E2E_URL (default http://localhost:5173), CHROMIUM (executable path),
//      E2E_DEPS (a folder with node_modules for the exported project: react, vite, typescript,
//      tailwindcss, postcss, autoprefixer, @vitejs/plugin-react; without it the build check is skipped).

import { chromium } from "playwright-core";
import JSZip from "jszip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
// Nothing may leave this machine.
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
const byName = async (name) => Object.values((await doc()).nodes).find((n) => n.name === name);
const select = async (name) => {
  const n = await byName(name);
  await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), n.id);
  await page.waitForTimeout(200);
};
const inspect = () => page.locator("[data-testid=inspect]");
const group = (title) => inspect().locator(`[role=group][aria-label^="${title}"]`);

// A 2x2 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYEJRAAAFAIBAJ3u1tUAAAAASUVORK5CYII=";

try {
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 20000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");

  // ---------- Setup ----------
  await page.evaluate(() => window.__dt.tool("define_variables", { collection: "Theme", modes: ["Light", "Dark"], variables: [{ name: "Brand/primary", type: "color", values: { Light: "#7C5CFF", Dark: "#B3A3FF" } }] }));
  await page.evaluate(() =>
    window.__dt.tool("define_styles", {
      colors: [{ name: "Ink", color: "#111827" }],
      texts: [{ name: "Heading 1", fontFamily: "Inter", fontSize: 28, fontWeight: 700, lineHeight: 36, letterSpacing: -0.5 }],
    }),
  );
  const r = await page.evaluate(() =>
    window.__dt.tool("create_nodes", {
      parentId: null,
      nodes: [
        {
          type: "frame", name: "Card", x: 0, y: 0, width: 320, height: "hug", fill: "#FFFFFF", cornerRadius: 12,
          layout: { direction: "vertical", gap: 12, padding: [16, 24, 20, 8] },
          notes: "Use the 8px grid. Never nest cards.",
          bind: { fill: "Theme/Brand/primary" },
          children: [
            { type: "text", name: "Title", text: "Welcome back", textStyle: "Heading 1", fillStyle: "Ink" },
            { type: "frame", name: "Photo", width: 200, height: 120 },
            { type: "frame", name: "Logo", width: 40, height: 40, fill: "#FF0000" },
            { type: "frame", name: "Buy button", width: "fill", height: 44, fill: "#222222", layout: { direction: "horizontal" }, children: [{ type: "text", name: "Buy label", text: "Buy now", fontSize: 40 }] },
          ],
        },
        { type: "frame", name: "Home", x: 600, y: 0, width: 390, height: 600, fill: "#FFFFFF" },
        { type: "frame", name: "Spare badge", x: 0, y: 900, width: 80, height: 30, fill: "#00AA00" },
      ],
    }),
  );
  check("setup created the fixture", !r.isError, JSON.stringify(r).slice(0, 200));
  // An image fill from a registered asset, an export row, an unused main component with a description.
  const photo = await byName("Photo");
  await page.evaluate(
    async ([id, png]) => {
      const m = await import("/src/assets.ts");
      const asset = m.addAsset(png);
      window.__dt.dispatch({ op: "update", ids: [id], patch: { fills: [{ type: "image", src: "asset:" + asset, scaleMode: "fill", opacity: 1, visible: true }] } });
    },
    [photo.id, PNG],
  );
  const logo = await byName("Logo");
  await page.evaluate((id) => window.__dt.dispatch({ op: "update", ids: [id], patch: { exportSettings: [{ format: "png", scale: 2, suffix: "" }] } }), logo.id);
  const spare = await byName("Spare badge");
  await page.evaluate((id) => window.__dt.dispatch({ op: "createComponent", ids: [id] }), spare.id);
  await page.evaluate((id) => window.__dt.dispatch({ op: "update", ids: [id], patch: { component: { description: "A small badge. Not on any screen yet." } } }), spare.id);
  await page.waitForTimeout(300);

  // ---------- Inspect ----------
  await select("Card");
  await page.click("#right-tab-code");
  await inspect().waitFor({ timeout: 5000 });
  const layout = (await group("Layout").innerText()).replace(/\s+/g, " ");
  check("Inspect shows the gap", /Gap\s*12/.test(layout), layout);
  const pad = await group("Layout").locator(".insp-box").innerText();
  check("Inspect shows the padding values in a box", ["16", "24", "20", "8"].every((v) => pad.includes(v)), pad.replace(/\s+/g, " "));
  const padVals = await group("Layout").locator(".insp-box .insp-val").allInnerTexts();
  check("padding top, right, bottom, left each have a value", padVals.join(",") === "16,8,24,20", padVals.join(","));
  check("Inspect shows the radius", /Radius\s*12/.test((await group("Appearance").innerText()).replace(/\s+/g, " ")));

  const colours = group("Fill");
  const fillVal = colours.locator(".insp-val").first();
  const hex = (await fillVal.innerText()).trim();
  check("the fill shows as hex by default", /^#[0-9A-F]{6}$/.test(hex), hex);
  await colours.getByRole("button", { name: "RGB" }).click();
  const rgb = (await colours.locator(".insp-val").first().innerText()).trim();
  check("switching to RGB shows rgb(…)", /^rgb\(\d+, \d+, \d+\)$/.test(rgb), rgb);
  await colours.getByRole("button", { name: "HSL" }).click();
  check("switching to HSL shows hsl(…)", /^hsl\(\d+, \d+%, \d+%\)$/.test((await colours.locator(".insp-val").first().innerText()).trim()));
  await colours.getByRole("button", { name: "Hex" }).click();
  await colours.locator(".insp-val").first().click();
  await page.waitForTimeout(150);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check("clicking the hex copies it", clip === hex, `${clip} vs ${hex}`);
  check("\"Copied\" appears", (await inspect().locator(".insp-live").innerText()).includes("Copied"));
  check("the fill bound to Brand/primary shows that name", (await colours.innerText()).includes("Brand/primary"), (await colours.innerText()).replace(/\s+/g, " "));
  await colours.getByRole("button", { name: "Token" }).click();
  check("Token format shows the variable for a bound fill", (await colours.innerText()).includes("var(--theme-brand-primary)") || (await colours.innerText()).includes("var(--brand-primary)"), (await colours.innerText()).replace(/\s+/g, " "));
  await colours.getByRole("button", { name: "Hex" }).click();
  check("the designer's note appears as an annotation", (await page.locator("[data-testid=inspect-note]").innerText()).includes("Never nest cards"));

  await select("Title");
  const typo = (await group("Typography").innerText()).replace(/\s+/g, " ");
  check("text linked to a style shows the style name", typo.includes("Heading 1"), typo);
  check("typography shows size, weight and line height", /Size\s*28px/.test(typo) && /Weight\s*700/.test(typo) && /Line height\s*36px/.test(typo), typo);
  check("a colour style shows its name", (await group("Fill").innerText()).includes("Ink"), (await group("Fill").innerText()).replace(/\s+/g, " "));

  // Mixed text styles, gradients as real CSS, top paint first.
  const title = await byName("Title");
  await page.evaluate((id) => window.__dt.dispatch({ op: "update", ids: [id], patch: { text: { runs: [{ start: 0, end: 3, fontWeight: 700, fontSize: 40 }] } } }), title.id);
  await page.waitForTimeout(200);
  check("mixed text styles are listed", (await group("Typography").innerText()).includes("Mixed") && (await group("Typography").innerText()).includes("0-3"), (await group("Typography").innerText()).replace(/\s+/g, " "));
  await page.evaluate(() => window.__dt.tool("create_nodes", { parentId: null, nodes: [{ type: "frame", name: "Grad", x: 0, y: 2000, width: 100, height: 100, fill: "linear-gradient(90deg, #FF0000 0%, #0000FF 100%)" }] }));
  await select("Grad");
  await group("Fill").getByRole("button", { name: "Token" }).click();
  const gradText = await group("Fill").locator(".insp-val").first().innerText();
  check("a gradient shows as a CSS linear-gradient()", /^linear-gradient\(90deg, #ff0000 0%, #0000ff 100%\)$/.test(gradText), gradText);
  await group("Fill").getByRole("button", { name: "Hex" }).click();

  // ---------- Assets ----------
  await select("Card");
  const assets = group("Assets");
  const names = await assets.locator(".insp-asset-name").allInnerTexts();
  check("Assets lists the image fill and the exportable layer", names.some((t) => t.includes("Photo")) && names.some((t) => t.includes("Logo")), names.join(" | "));
  const [imgDl] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), assets.getByRole("button", { name: "Download Photo" }).click()]);
  const imgBytes = fs.readFileSync(await imgDl.path());
  check("the image download is the original PNG", imgDl.suggestedFilename() === "Photo.png" && imgBytes.subarray(1, 4).toString() === "PNG", imgDl.suggestedFilename());
  const [logoDl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), assets.getByRole("button", { name: "Download Logo" }).click()]);
  const logoBytes = fs.readFileSync(await logoDl.path());
  check("an exportable layer downloads its export row (PNG 2x)", logoDl.suggestedFilename().startsWith("Logo") && logoBytes.readUInt32BE(16) === 80, `${logoDl.suggestedFilename()} ${logoBytes.readUInt32BE(16)}`);

  // ---------- Code snippet ----------
  const snippet = async () => page.locator(".code-block").innerText();
  const react = await snippet();
  check("the React snippet has no inlined image", !react.includes("data:image"));
  check("the React snippet shows /assets/ paths with a note", /\/assets\/\w+\.png/.test(react) && react.includes("Copy with images inline"), react.slice(0, 200));
  const codeSection = page.locator(".section", { has: page.locator(".section-head", { hasText: "Card" }) });
  await codeSection.getByRole("button", { name: "Copy (image paths)" }).click();
  await page.waitForTimeout(150);
  const pathCopy = await page.evaluate(() => navigator.clipboard.readText());
  check("Copy copies the asset paths", /\/assets\/\w+\.png/.test(pathCopy) && !pathCopy.includes("data:image"), pathCopy.slice(0, 100));
  await codeSection.getByRole("button", { name: "Copy with images inline" }).click();
  await page.waitForTimeout(150);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check("Copy with images inline copies working code", copied.includes("data:image/png") && !copied.includes("asset:"), copied.slice(0, 100));
  check("the snippet has no nested interactive elements", !/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/.test(react), "");
  check("text in the button is a span, not a heading", !/<h1[^>]*>\{"Buy now"\}/.test(react) && /<span[^>]*>\{"Buy now"\}<\/span>/.test(react), react.match(/.*Buy now.*/)?.[0]);

  // ---------- Project download ----------
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await select("Card");
  const [zipDl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.getByRole("button", { name: /Download React \+ Tailwind project/ }).click()]);
  const zipPath = await zipDl.path();
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const files = Object.keys(zip.files).filter((f) => !zip.files[f].dir);
  const comps = await zip.file("src/components.tsx").async("string");
  check("components.tsx has the main component that no screen uses", comps.includes("export function SpareBadge("), comps.slice(0, 300));
  check("the component's description is a JSDoc comment", comps.includes("/** A small badge. Not on any screen yet. */"));
  let inSrc = 0;
  for (const f of files.filter((f) => f.startsWith("src/"))) if ((await zip.file(f).async("string")).includes("data:image")) inSrc++;
  check("no data:image in src/", inSrc === 0, `${inSrc} files`);
  check("the image is a file in public/assets", files.some((f) => /^public\/assets\/\w+\.png$/.test(f)), files.filter((f) => f.startsWith("public")).join(","));
  const css = await zip.file("src/index.css").async("string");
  const card = await zip.file("src/screens/Card.tsx").async("string");
  check("text styles become classes in index.css and the element uses it", css.includes(".text-heading-1") && card.includes("text-heading-1"), css.slice(-300));
  check("colour styles become custom properties", css.includes("--color-ink: #111827") && card.includes("var(--color-ink)"), css.slice(-300));
  check("the screen has no nested buttons", !/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/.test(card));
  const tokens = await zip.file("src/tokens.ts")?.async("string");
  check("a two-mode collection exports setMode and both [data-theme] blocks", !!tokens && tokens.includes("export function setMode") && (await zip.file("src/tokens.css").async("string")).includes('[data-theme="dark"]'), tokens?.slice(0, 200));

  // The exported project must still compile.
  const deps = process.env.E2E_DEPS;
  /** Writes project files (and image binaries) to a folder, then runs tsc and vite build in it. */
  const compile = (label, projectFiles, binaries = []) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w3f-project-"));
    for (const f of projectFiles) {
      fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, f.path), f.data ?? f.content);
    }
    for (const b of binaries) {
      fs.mkdirSync(path.dirname(path.join(dir, b.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, b.path), Buffer.from(b.dataUrl.split(",")[1], "base64"));
    }
    fs.symlinkSync(path.join(deps, "node_modules"), path.join(dir, "node_modules"));
    let ok = true;
    let out = "";
    for (const [bin, args] of [["tsc", ["-b"]], ["vite", ["build"]]]) {
      try {
        out = execFileSync(path.join(dir, "node_modules/.bin", bin), args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
      } catch (e) {
        ok = false;
        out = String(e.stdout ?? "") + String(e.stderr ?? "");
        break;
      }
    }
    check(`${label} passes tsc and vite build`, ok, ok ? dir : out.slice(0, 600));
  };
  if (deps) {
    const projectFiles = [];
    for (const f of files) projectFiles.push({ path: f, data: Buffer.from(await zip.file(f).async("uint8array")) });
    compile("the exported test project", projectFiles);
    for (const id of ["landing", "dashboard", "system", "mobile"]) {
      await page.goto(URL);
      await page.waitForSelector(".files", { timeout: 20000 });
      await page.click("button:has-text('New design file')");
      await page.waitForSelector("#dt-canvas");
      const built = await page.evaluate(async (tid) => {
        const t = await import("/src/templates.ts");
        t.TEMPLATES.find((x) => x.id === tid).build();
        const ex = await import("/src/exporter.ts");
        return ex.projectFiles();
      }, id);
      const comps = built.files.find((f) => f.path === "src/components.tsx").content;
      compile(`the exported ${id} template`, built.files, built.binaries);
      if (id === "system") check("the design system template exports its components", (comps.match(/^export function /gm) ?? []).length >= 3, `${(comps.match(/^export function /gm) ?? []).length} exported functions`);
    }
  } else {
    console.log("SKIP  exported project builds (set E2E_DEPS)");
  }

  check("no page errors", errors.length === 0, errors.join("; "));
} catch (err) {
  failed++;
  console.log("FAIL  script error  — " + (err.stack ?? err));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
