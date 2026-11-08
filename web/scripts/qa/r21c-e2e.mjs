// Round 21, package r21c (images): a drop of several files is one grid and one undo step, paste goes
// into the selected frame, choosing an image is its own undo step, big images are scaled to 4096 px,
// the photo search no longer says "JSON", and the mask hint.
// Usage: serve web/dist (`vite preview --port 7621`), then
//   E2E_URL=http://localhost:7621 node scripts/qa/r21c-e2e.mjs
// Env: E2E_URL, CHROMIUM, SHOTS (screenshot dir), TIMING=1 (60-file drop timing).
// Local servers only: every other request is aborted. Test images are drawn in the page.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL_ = process.env.E2E_URL ?? "http://localhost:7621";
const SHOTS = process.env.SHOTS ?? "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).replace(/\s+/g, " ") : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = /^(https?:\/\/(localhost|127\.0\.0\.1)[:/]|data:|blob:|ws:)/;

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
const dialogs = [];
// Everything off this machine is refused; the Openverse search answers with something that is not JSON.
await context.route("**/*", (r) => {
  const u = r.request().url();
  if (/^https:\/\/api\.openverse\.org\/v1\/images\/\?/.test(u)) {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,accept", "access-control-allow-methods": "GET" } });
    return r.fulfill({ status: 200, body: "<html>maintenance</html>", headers: { "access-control-allow-origin": "*", "content-type": "text/html" } });
  }
  return LOCAL.test(u) ? r.continue() : r.abort();
});
await context.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
const page = await context.newPage();
page.on("pageerror", (e) => check("no page errors", false, String(e)));
page.on("dialog", (d) => {
  // Leaving a file with unsaved changes asks the browser's own question; that one is let through.
  if (d.type() === "beforeunload") return void d.accept().catch(() => {});
  dialogs.push(d.message());
  d.dismiss().catch(() => {});
});

const run = (cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const tool = (name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const nodes = () => page.evaluate(() => window.__dt.doc().nodes);
const state = () => page.evaluate(() => window.__dt.state());
const toasts = async () => (await page.locator(".toast").allInnerTexts()).join(" | ");
const layers = async () => Object.values(await nodes()).filter((n) => n.type !== "page" && n.fills?.some((f) => f.type === "image"));
const undo = () => run({ op: "undo" });
const redo = () => run({ op: "redo" });

/** The page point under a client point, with the view at x:0 y:0 zoom 1 (the canvas' own origin). */
async function view(x = 0, y = 0, zoom = 1) {
  await page.evaluate(([x, y, zoom]) => window.__dt.setViewport({ x, y, zoom }), [x, y, zoom]);
  await sleep(100);
}
const canvasBox = () => page.evaluate(() => document.getElementById("dt-canvas").getBoundingClientRect().toJSON());

/** A PNG/JPEG drawn in the page, as a File: { name, type, w, h, color }. */
const MAKE = `
  async (spec) => {
    const c = document.createElement("canvas");
    c.width = spec.w;
    c.height = spec.h;
    const g = c.getContext("2d");
    g.fillStyle = spec.color ?? "#e33";
    g.fillRect(0, 0, spec.w, spec.h);
    g.fillStyle = "#39f";
    g.fillRect(0, 0, Math.ceil(spec.w / 2), Math.ceil(spec.h / 2));
    const blob = await new Promise((r) => c.toBlob(r, spec.type ?? "image/png", 0.9));
    return new File([blob], spec.name, { type: spec.type ?? "image/png" });
  }`;

async function drop(specs, clientX, clientY, extra = []) {
  await page.evaluate(
    async ([specs, x, y, extra, make]) => {
      const mk = eval(make);
      const dt = new DataTransfer();
      for (const s of specs) dt.items.add(await mk(s));
      for (const e of extra) dt.items.add(new File([Uint8Array.from(atob(e.b64), (c) => c.charCodeAt(0))], e.name, { type: e.type }));
      document.getElementById("dt-canvas").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    },
    [specs, clientX, clientY, extra, MAKE],
  );
}

async function paste(spec) {
  await page.evaluate(
    async ([spec, make]) => {
      const mk = eval(make);
      const dt = new DataTransfer();
      dt.items.add(await mk(spec));
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [spec, MAKE],
  );
}

const waitLayers = (n) => page.waitForFunction((n) => Object.values(window.__dt.doc().nodes).filter((x) => x.fills?.some((f) => f.type === "image")).length >= n, n, { timeout: 30000 });
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** An uncompressed GIF (every group of two pixels is preceded by a clear code), so no encoder is needed. */
function gifBase64(w, h) {
  const bits = [];
  const put = (v, n) => {
    for (let i = 0; i < n; i++) bits.push((v >> i) & 1);
  };
  const pixels = w * h;
  for (let i = 0; i < pixels; i += 2) {
    put(4, 3); // clear
    put(i % 3 === 0 ? 1 : 0, 3);
    if (i + 1 < pixels) put(0, 3);
  }
  put(4, 3);
  put(5, 3); // end
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b |= bits[i + k] << k;
    data.push(b);
  }
  const out = [...Buffer.from("GIF89a"), w & 255, w >> 8, h & 255, h >> 8, 0x80, 0, 0, 255, 0, 0, 0, 0, 255, 0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 2];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0, 0x3b);
  return Buffer.from(out).toString("base64");
}

/** The asset images the canvas has loaded: natural size and type of each blob. */
const loadedAssets = () =>
  page.evaluate(async () => {
    const hrefs = [...new Set([...document.querySelectorAll("#dt-canvas image, #dt-canvas pattern image")].map((i) => i.getAttribute("href") || i.getAttribute("xlink:href")).filter((h) => h && h.startsWith("blob:")))];
    const out = [];
    for (const h of hrefs) {
      const blob = await (await fetch(h)).blob();
      const size = await new Promise((res) => {
        const img = new Image();
        img.onload = () => res([img.naturalWidth, img.naturalHeight]);
        img.onerror = () => res([0, 0]);
        img.src = h;
      });
      out.push({ w: size[0], h: size[1], type: blob.type, bytes: blob.size });
    }
    return out;
  });

async function newFile() {
  await page.goto(URL_);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(300);
}

try {
  await newFile();
  await view();
  const box = await canvasBox();

  // ===== 1. Twelve PNGs in one drop: a grid, all selected, one undo step =====
  {
    const specs = Array.from({ length: 12 }, (_, i) => ({ name: `pic${i + 1}.png`, w: 60 + ((i * 37) % 120), h: 50 + ((i * 53) % 110), color: ["#e33", "#3a3", "#33e", "#ea3"][i % 4] }));
    await drop(specs, box.left + 600, box.top + 400);
    await waitLayers(12);
    await sleep(300);
    const L = await layers();
    check("12 layers were created", L.length === 12, L.length);
    let clash = 0;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) if (overlap(L[i], L[j])) clash++;
    check("no two bounding boxes intersect", clash === 0, `${clash} overlapping pairs`);
    const x0 = Math.min(...L.map((n) => n.x));
    const y0 = Math.min(...L.map((n) => n.y));
    const x1 = Math.max(...L.map((n) => n.x + n.width));
    const y1 = Math.max(...L.map((n) => n.y + n.height));
    check("their union is centred on the drop point within 2 px", Math.abs((x0 + x1) / 2 - 600) <= 2 && Math.abs((y0 + y1) / 2 - 400) <= 2, `${(x0 + x1) / 2},${(y0 + y1) / 2}`);
    const sel = (await state()).selection;
    check("all 12 are selected", sel.length === 12 && L.every((n) => sel.includes(n.id)), sel.length);
    check("the layers keep their own size (the first is 60x50)", L.some((n) => n.name === "pic1" && n.width === 60 && n.height === 50));
    if (SHOTS) {
      await run({ op: "select", ids: [] });
      await page.evaluate(() => window.__dt.zoomToFit());
      await sleep(500);
      await page.screenshot({ path: path.join(SHOTS, "r21c-grid-12.png") });
      await view();
    }
    await undo();
    check("one undo removes all 12", (await layers()).length === 0, (await layers()).length);
    await redo();
    check("one redo restores all 12", (await layers()).length === 12, (await layers()).length);
    await undo();
    check("no toast about scaling for small images", !/Scaled/.test(await toasts()));
  }

  // ===== 2. Three PNGs dropped inside a frame become its children =====
  {
    const made = (await tool("create_nodes", { nodes: [{ type: "frame", name: "Drop frame", x: 1200, y: 0, width: 800, height: 600, fill: "#FFFFFF" }] })).result.created[0].id;
    await view(-1000, 0);
    await drop([{ name: "in1.png", w: 100, h: 80 }, { name: "in2.png", w: 120, h: 90 }, { name: "in3.png", w: 90, h: 90 }], box.left + 600, box.top + 300);
    await waitLayers(3);
    await sleep(300);
    const frame = (await nodes())[made];
    const kids = (await layers()).filter((n) => /^in[123]$/.test(n.name));
    check("all three are children of the frame", kids.length === 3 && kids.every((n) => n.parent === made) && frame.children.length === 3, kids.map((n) => n.parent).join(","));
    await undo();
    check("and one undo removes all three", (await layers()).length === 0);
  }

  // ===== 3. Paste goes into the selected frame =====
  {
    const ids = (
      await tool("create_nodes", {
        nodes: [
          { type: "frame", name: "Paste frame", x: 0, y: 1000, width: 400, height: 300, fill: "#FFFFFF", children: [{ type: "rectangle", name: "Inner", x: 20, y: 20, width: 50, height: 50, fill: "#CCCCCC" }] },
          { type: "frame", name: "Centre frame", x: 5000, y: 5000, width: 1000, height: 1000, fill: "#EEEEEE" },
        ],
      })
    ).result.created.map((c) => c.id);
    const [pf] = ids;
    const inner = Object.values(await nodes()).find((n) => n.name === "Inner");
    await view(0, -900);
    await run({ op: "select", ids: [pf] });
    await paste({ name: "pasted1.png", w: 100, h: 60 });
    await waitLayers(1);
    await sleep(200);
    let n = Object.values(await nodes()).find((x) => x.name === "pasted1");
    const frameBox = (await nodes())[pf];
    check("with a frame selected the image is its child, centred in it", n?.parent === pf && Math.abs(n.x + n.width / 2 - frameBox.width / 2) <= 1 && Math.abs(n.y + n.height / 2 - frameBox.height / 2) <= 1, n && `${n.parent} ${n.x},${n.y}`);
    await run({ op: "select", ids: [inner.id] });
    await paste({ name: "pasted2.png", w: 80, h: 80 });
    await waitLayers(2);
    await sleep(200);
    n = Object.values(await nodes()).find((x) => x.name === "pasted2");
    check("with a child of a frame selected it goes into that frame", n?.parent === pf, n?.parent);
    check("a pasted image is selected", (await state()).selection.includes(n?.id));
    await undo();
    check("pasting is one undo step", !Object.values(await nodes()).some((x) => x.name === "pasted2"));
    // Nothing selected: the frame under the view centre, as before.
    await run({ op: "select", ids: [] });
    await page.evaluate(([w, h]) => window.__dt.setViewport({ x: w / 2 - 5500, y: h / 2 - 5500, zoom: 1 }), [box.width, box.height]);
    await sleep(100);
    await paste({ name: "pasted3.png", w: 70, h: 70 });
    await waitLayers(2);
    await sleep(200);
    n = Object.values(await nodes()).find((x) => x.name === "pasted3");
    const cf = Object.values(await nodes()).find((x) => x.name === "Centre frame");
    check("with nothing selected it goes into the frame under the view centre", n?.parent === cf.id && Math.abs(cf.x + n.x + n.width / 2 - 5500) <= 1, n?.parent);
    // A selected frame that is out of view is not used.
    await run({ op: "select", ids: [pf] });
    await paste({ name: "pasted4.png", w: 70, h: 70 });
    await sleep(500);
    n = Object.values(await nodes()).find((x) => x.name === "pasted4");
    check("a selected frame out of view is ignored (view centre, as before)", n?.parent === cf.id, n?.parent);
  }

  // ===== 3b. Not into an instance, or a frame inside one =====
  {
    await newFile();
    await view();
    const made = (await tool("create_nodes", { nodes: [{ type: "frame", name: "Main", x: 100, y: 100, width: 300, height: 200, fill: "#FFFFFF", children: [{ type: "frame", name: "Part", x: 20, y: 20, width: 100, height: 100, fill: "#EEEEEE" }] }] })).result.created[0].id;
    await run({ op: "createComponent", ids: [made] });
    const comp = Object.values(await nodes()).find((n) => n.type === "component");
    await run({ op: "createInstance", componentId: comp.id, x: 600, y: 100, parent: null });
    const all = await nodes();
    const inst = Object.values(all).find((n) => n.type === "instance");
    const part = Object.values(all).find((n) => n.name === "Part" && n.masterId);
    check("a frame inside an instance exists", !!inst && !!part);
    await run({ op: "select", ids: [part.id] });
    await paste({ name: "into-inst.png", w: 40, h: 40 });
    await sleep(500);
    const n = Object.values(await nodes()).find((x) => x.name === "into-inst");
    const under = (id) => {
      for (let c = all[id]; c; c = c.parent ? all[c.parent] : null) if (c.id === inst.id) return true;
      return false;
    };
    check("pasting with a frame inside an instance selected does not go into the instance", !!n && !(n.parent && (under(n.parent) || (all[n.parent] ?? {}).masterId)), n?.parent);
  }

  // ===== 3c. A paste while a paint popover is open keeps the popover's undo steps =====
  {
    await newFile();
    await view();
    const id = (await tool("create_nodes", { nodes: [{ type: "rectangle", name: "Pop", x: 100, y: 100, width: 100, height: 100, fill: "#3366FF" }] })).result.created[0].id;
    await run({ op: "select", ids: [id] });
    await sleep(300);
    await page.locator(".panel.right button.swatch").first().click();
    await page.waitForSelector(".popover");
    await page.click(".popover .paint-type button:has-text('Linear')");
    await sleep(200);
    await paste({ name: "during.png", w: 50, h: 50 });
    await waitLayers(1);
    await sleep(300);
    await page.keyboard.press("Escape");
    await sleep(200);
    const type = async () => (await nodes())[id].fills[0].type;
    check("the paste happened and the gradient is still there", (await type()) === "linearGradient");
    await undo();
    check("first undo removes the pasted image only", (await layers()).length === 0 && (await type()) === "linearGradient", `${(await layers()).length} ${await type()}`);
    await undo();
    check("second undo restores the solid fill", (await type()) === "solid", await type());
  }

  // ===== 4. Choosing an image is its own undo step =====
  {
    await newFile();
    await view();
    const id = (await tool("create_nodes", { nodes: [{ type: "rectangle", name: "Slot", x: 100, y: 100, width: 200, height: 150, fill: "#3366FF" }] })).result.created[0].id;
    await run({ op: "select", ids: [id] });
    await sleep(300);
    const fill = async () => (await nodes())[id].fills[0];
    await page.locator(".panel.right button.swatch").first().click();
    await page.waitForSelector(".popover");
    await page.click(".popover .paint-type button[title='Image']");
    await sleep(200);
    const png = Buffer.from(await page.evaluate(async (make) => {
      const f = await eval(make)({ name: "pick.png", w: 64, h: 48 });
      const b = new Uint8Array(await f.arrayBuffer());
      let s = "";
      for (const x of b) s += String.fromCharCode(x);
      return btoa(s);
    }, MAKE), "base64");
    const chooser = page.waitForEvent("filechooser");
    await page.click(".popover button:has-text('Choose image')");
    await (await chooser).setFiles({ name: "pick.png", mimeType: "image/png", buffer: png });
    await page.waitForFunction((id) => window.__dt.doc().nodes[id].fills[0].src?.startsWith("asset:"), id, { timeout: 8000 });
    await page.locator(".popover input[data-adjust='exposure']").evaluate((el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "40");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(300);
    check("the image fill carries the exposure", (await fill()).filters?.exposure > 0.3, JSON.stringify((await fill()).filters));
    await page.keyboard.press("Escape");
    await sleep(200);
    await undo();
    let f = await fill();
    check("first undo: the image is still there, exposure back to 0", f.type === "image" && f.src.startsWith("asset:") && !(f.filters?.exposure > 0), JSON.stringify(f).slice(0, 160));
    await undo();
    f = await fill();
    check("second undo: the fill is solid again", f.type === "solid" && f.color.toLowerCase() === "#3366ff", JSON.stringify(f).slice(0, 160));
    await redo();
    await redo();
    check("redo twice brings the adjusted image back", (await fill()).filters?.exposure > 0.3);
    // Adjusting alone is still one step per popover session.
    await page.locator(".panel.right button.swatch").first().click();
    await page.waitForSelector(".popover .image-adjust");
    const before = (await fill()).filters?.exposure;
    for (const v of ["10", "20", "30"]) {
      await page.locator(".popover input[data-adjust='contrast']").evaluate((el, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, v);
    }
    await page.keyboard.press("Escape");
    await sleep(200);
    await undo();
    check("sliders alone undo as one step", (await fill()).filters?.exposure === before && !((await fill()).filters?.contrast > 0), JSON.stringify((await fill()).filters));
  }

  // ===== 5. Downscaling =====
  {
    await newFile();
    await view();
    await drop([{ name: "huge.png", w: 8000, h: 6000 }], box.left + 700, box.top + 450);
    await waitLayers(1);
    await sleep(1200);
    const l = (await layers())[0];
    check("the layer of an 8000x6000 PNG is 4096x3072", l.width === 4096 && l.height === 3072, `${l?.width}x${l?.height}`);
    await view(-700 + box.width / 2, -450 + box.height / 2, 0.1);
    await sleep(800);
    const assets = await loadedAssets();
    check("the stored asset is 4096x3072 and still a PNG", assets.some((a) => a.w === 4096 && a.h === 3072 && a.type === "image/png") && !assets.some((a) => a.w === 8000), JSON.stringify(assets));
    check("a toast says it was scaled", /Scaled 1 large image down to 4096 px/.test(await toasts()), await toasts());

    // A 1200x800 JPEG keeps its bytes.
    await newFile();
    await view();
    const jpg = await page.evaluate(async (make) => {
      const f = await eval(make)({ name: "photo.jpg", type: "image/jpeg", w: 1200, h: 800, color: "#8a5" });
      const b = new Uint8Array(await f.arrayBuffer());
      let s = "";
      for (const x of b) s += String.fromCharCode(x);
      return btoa(s);
    }, MAKE);
    await drop([], box.left + 500, box.top + 300, [{ name: "photo.jpg", type: "image/jpeg", b64: jpg }]);
    await waitLayers(1);
    await sleep(800);
    await view(-500 + box.width / 2, -300 + box.height / 2, 0.4);
    await sleep(600);
    const bytes = await page.evaluate(async () => {
      const hrefs = [...document.querySelectorAll("#dt-canvas image")].map((i) => i.getAttribute("href")).filter((h) => h?.startsWith("blob:"));
      const out = [];
      for (const h of hrefs) {
        const b = new Uint8Array(await (await fetch(h)).arrayBuffer());
        let s = "";
        for (const x of b) s += String.fromCharCode(x);
        out.push(btoa(s));
      }
      return out;
    });
    check("a 1200x800 JPEG keeps byte-identical data", bytes.includes(jpg), `${bytes.length} images, ${jpg.length} chars`);
    check("and no scaling toast", !/Scaled/.test(await toasts()));

    // A big JPEG stays a JPEG; a GIF over 4096 px stays a GIF.
    await newFile();
    await view();
    const gif = gifBase64(5000, 10);
    await drop([{ name: "wide.jpg", type: "image/jpeg", w: 6000, h: 1000 }], box.left + 500, box.top + 300, [{ name: "strip.gif", type: "image/gif", b64: gif }]);
    await waitLayers(2);
    await sleep(1500);
    const L = await layers();
    const wide = L.find((n) => n.name === "wide");
    const strip = L.find((n) => n.name === "strip");
    check("a 6000x1000 JPEG is scaled to 4096x683", wide?.width === 4096 && wide?.height === 683, `${wide?.width}x${wide?.height}`);
    check("a 5000x10 GIF's layer is capped at 4096 wide as before", strip?.width === 4096 && strip?.height === 8, `${strip?.width}x${strip?.height}`);
    await view(-500 + box.width / 2, -300 + box.height / 2, 0.15);
    await sleep(800);
    const assets2 = await loadedAssets();
    check("the JPEG asset is still a JPEG and the GIF asset a GIF at full size", assets2.some((a) => a.type === "image/jpeg" && a.w === 4096) && assets2.some((a) => a.type === "image/gif" && a.w === 5000), JSON.stringify(assets2));
    check("the scaling toast counts only the JPEG", /Scaled 1 large image/.test(await toasts()), await toasts());
  }

  // ===== 5b. A mix: SVG, PNG, a file that is not an image, and a .dtron-looking file =====
  {
    await newFile();
    await view();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60" viewBox="0 0 80 60"><rect width="80" height="60" fill="#0a0"/></svg>').toString("base64");
    const junk = Buffer.from("not an image").toString("base64");
    await drop([{ name: "p1.png", w: 100, h: 100 }, { name: "p2.png", w: 90, h: 70 }], box.left + 600, box.top + 400, [
      { name: "icon.svg", type: "image/svg+xml", b64: svg },
      { name: "broken.png", type: "image/png", b64: junk },
    ]);
    await sleep(2000);
    const all = Object.values(await nodes()).filter((n) => ["p1", "p2", "icon"].includes(n.name));
    check("the PNGs and the SVG were placed, the broken file skipped", all.length === 3, all.map((n) => n.name).join(","));
    check("one toast about the file that could not be read", /Couldn't read “broken.png”/.test(await toasts()), await toasts());
    await undo();
    check("the mix is one undo step", Object.values(await nodes()).filter((n) => ["p1", "p2", "icon"].includes(n.name)).length === 0);
  }

  // ===== 5c. A view-only file refuses the drop once =====
  {
    await newFile();
    await view();
    await page.evaluate(() => window.__dt.collabSet?.({ viewer: true }));
    await drop([{ name: "v1.png", w: 50, h: 50 }, { name: "v2.png", w: 50, h: 50 }], box.left + 300, box.top + 300);
    await sleep(600);
    check("a view-only file takes no images and says so", (await layers()).length === 0 && /view-only/.test(await toasts()), await toasts());
    await page.evaluate(() => window.__dt.collabSet?.({ viewer: false }));
  }

  // ===== 6. Photo search answers with something that is not JSON =====
  {
    await newFile();
    await page.click("#left-tab-assets");
    await page.waitForSelector("[data-testid=photos-section]");
    await page.fill("[data-testid=photo-search] input[type=search]", "sneakers");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".photo-note.error", { timeout: 8000 });
    const text = await page.locator(".photo-note.error").first().innerText();
    check("the error is plain words with no 'JSON'", /couldn't read/.test(text) && !/json/i.test(text) && /Try again/.test(text), text);
  }

  // ===== 7. Masks =====
  {
    await newFile();
    await view();
    const ids = (
      await tool("create_nodes", {
        nodes: [
          { type: "rectangle", name: "Photo", x: 100, y: 100, width: 200, height: 150, fill: "#3366FF" },
          { type: "ellipse", name: "Circle", x: 140, y: 120, width: 120, height: 120, fill: "#FF0000" },
        ],
      })
    ).result.created.map((c) => c.id);
    // Layer order: Photo is below Circle, so Photo is the bottom layer and becomes the mask.
    await run({ op: "select", ids });
    await page.evaluate(() => document.querySelector("#dt-canvas").focus?.());
    await page.keyboard.press("Control+Alt+KeyM");
    await sleep(300);
    const t = await toasts();
    check("Use as mask names the bottom layer and says it clips the layers above", /“Photo” now masks the layers above it/.test(t), t);
    const mask = Object.values(await nodes()).find((n) => n.name === "Photo");
    check("the bottom layer is the mask", mask?.isMask === true);
    // A lone layer on top: nothing above it.
    await newFile();
    await view();
    const lone = (await tool("create_nodes", { nodes: [{ type: "rectangle", name: "Top", x: 100, y: 100, width: 100, height: 100, fill: "#00AA00" }] })).result.created[0].id;
    await run({ op: "select", ids: [lone] });
    await page.keyboard.press("Control+Alt+KeyM");
    await sleep(300);
    check("a lone top layer made a mask warns that nothing is above it", /“Top” is a mask, but nothing is above it to clip/.test(await toasts()), await toasts());
    check("the Layers mask icon is named", (await page.locator(".mask-icon[title='Mask: clips the layers above it']").count()) >= 1);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "r21c-mask-hint.png") });
  }

  // ===== 8. Timing: a drop of 60 files =====
  if (process.env.TIMING) {
    const times = [];
    for (let k = 0; k < 3; k++) {
      await newFile();
      await view();
      const specs = Array.from({ length: 60 }, (_, i) => ({ name: `t${i}.png`, w: 80 + ((i * 37) % 100), h: 60 + ((i * 53) % 90) }));
      const t0 = Date.now();
      await drop(specs, box.left + 800, box.top + 450);
      await waitLayers(60);
      times.push(Date.now() - t0);
      if (k === 0) {
        const L = await layers();
        let clash = 0;
        for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) if (overlap(L[i], L[j])) clash++;
        const cols = L.filter((n) => n.y === L[0].y).length;
        check("60 files: no overlaps", clash === 0, `${clash} pairs, ${cols} columns in the first row`);
        await undo();
        check("60 files: one undo removes them all", (await layers()).length === 0);
      }
    }
    console.log(`TIMING 60-file drop (ms, prepare + apply, incl. making the files): ${times.join(", ")}`);
  }

  check("no browser dialogs", dialogs.length === 0, dialogs.join(" | "));
} catch (err) {
  check("unexpected exception", false, String(err?.stack ?? err));
} finally {
  await browser.close();
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
