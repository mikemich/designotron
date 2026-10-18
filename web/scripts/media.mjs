// Captures README screenshots and the demo GIF into docs/media.
// Needs the bridge serving the production build (npm run build; designotron on 5174).
// Usage: node scripts/media.mjs

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const URL_ = process.env.E2E_URL ?? "http://127.0.0.1:5174";
const OUT = path.resolve(import.meta.dirname, "../../docs/media");
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const browser = await chromium.launch(launch);
const viewport = { width: 1440, height: 900 };
const init = () => {
  try {
    localStorage.setItem("dt:tour-done", "1");
    localStorage.setItem("dt:userName", "Mika");
  } catch {
    /* sandboxed frames */
  }
};
const settle = (page, ms = 600) => page.waitForTimeout(ms);

// --- Screenshots -----------------------------------------------------------
{
  const page = await (await browser.newContext({ viewport, deviceScaleFactor: 2 })).newPage();
  await page.addInitScript(init);
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await page.goto(URL_);
  await page.waitForSelector(".files");
  await settle(page);
  await shot("dashboard");

  await page.click(".file-card:has-text('Landing page')");
  await page.waitForSelector("#dt-canvas");
  await settle(page, 1200);
  await page.evaluate(() => window.__dt.zoomToFit());
  await settle(page);
  await shot("editor");

  await page.keyboard.press("Control+/");
  await page.waitForSelector(".chat");
  await settle(page);
  await shot("claude");
  await page.keyboard.press("Control+/");

  await page.click(".panel.right .tab:has-text('Review')");
  await settle(page);
  await shot("review");

  await page.evaluate(() => {
    const d = window.__dt.doc();
    const top = d.pages[0].children.find((id) => d.nodes[id].type === "frame");
    window.__dt.dispatch({ op: "select", ids: [top] });
  });
  await page.click(".panel.right .tab:has-text('Code')");
  await settle(page);
  await shot("code");
  await browser.contexts()[0].close();
}

// --- Demo GIF --------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(OUT, ".video-"));
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.addInitScript(init);
  // CDP screencast frames (timestamped JPEGs), encoded with the system ffmpeg afterwards.
  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = path.join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
  await page.goto(URL_);
  await page.waitForSelector(".files");
  await settle(page, 900);
  await page.click(".file-card:has-text('Mobile app')");
  await page.waitForSelector("#dt-canvas");
  await settle(page, 1400);
  // Select the first screen, show it in code, then run the review fixes.
  const first = await page.evaluate(() => {
    const d = window.__dt.doc();
    return d.pages[0].children.find((id) => d.nodes[id].type === "frame");
  });
  await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), first);
  await settle(page, 700);
  await page.keyboard.press("Shift+2");
  await settle(page, 900);
  // Drag the screen a little to show direct manipulation.
  const box = await page.evaluate((id) => {
    const r = document.querySelector(`[data-label="${id}"]`).getBoundingClientRect();
    return { x: r.x + 6, y: r.bottom + 12 };
  }, first);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + i * 6, box.y + i * 2);
  await page.mouse.up();
  await settle(page, 500);
  await page.keyboard.press("Control+z");
  await settle(page, 600);
  await page.click(".panel.right .tab:has-text('Code')");
  await settle(page, 1500);
  await page.click(".panel.right .tab:has-text('Review')");
  await settle(page, 1000);
  const fix = page.locator("button:has-text('automatically')");
  if (await fix.count()) {
    await fix.click();
    await settle(page, 1000);
  }
  await page.click(".panel.right .tab:has-text('Design')");
  await page.keyboard.press("Shift+1");
  await settle(page, 1200);
  await page.keyboard.press("Control+/");
  await page.waitForSelector(".chat");
  await settle(page, 1800);
  await cdp.send("Page.stopScreencast");
  await context.close();
  // Concat list with each frame shown until the next one arrived.
  const list = frames
    .map((f, i) => `file '${f.file}'\nduration ${Math.max(0.02, ((frames[i + 1]?.t ?? f.t + 1) - f.t)).toFixed(3)}`)
    .join("\n");
  const listFile = path.join(dir, "frames.txt");
  fs.writeFileSync(listFile, list + `\nfile '${frames.at(-1).file}'\n`);
  const src = path.join(dir, "demo.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-vsync", "vfr", "-pix_fmt", "yuv420p", src]);
  const gif = path.join(OUT, "demo.gif");
  const palette = path.join(dir, "palette.png");
  const filters = "fps=12,scale=960:-1:flags=lanczos";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-vf", `${filters},palettegen=stats_mode=diff`, palette]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-i", palette, "-lavfi", `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, gif]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`demo.gif ${(fs.statSync(gif).size / 1024).toFixed(0)} KB`);
}
await browser.close();
console.log("wrote", fs.readdirSync(OUT).join(", "));
