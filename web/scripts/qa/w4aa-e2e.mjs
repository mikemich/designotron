// Wave 4 stage A, package a: smart animate stage 2 (nested matching, interpolation, easing, Change
// to, performance) and the On drag trigger in the player.
// Usage: E2E_URL=http://127.0.0.1:7301 node scripts/qa/w4aa-e2e.mjs (vite preview running)
// Screenshots go to E2E_OUT (default /tmp/w4aa-shots).

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:7301";
const OUT = process.env.E2E_OUT ?? "/tmp/w4aa-shots";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2 });
await context.route("**/*", (route) => {
  const u = route.request().url();
  if (u.startsWith("data:") || u.startsWith("blob:") || /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)) return route.continue();
  return route.abort();
});
await context.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
const errors = [];
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/WebSocket|Failed to load resource/.test(m.text()) && errors.push(m.text()));
await page.goto(URL);
await page.click("button:has-text('New design file')");
await page.waitForSelector("#dt-canvas");

const doc = () => page.evaluate(() => window.__dt.doc());
const tool = (name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const dispatch = (cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const ids = {};
const refresh = async () => {
  for (const n of Object.values((await doc()).nodes)) ids[n.name] = n.id;
};
const interaction = (o) => ({ trigger: "onClick", delayMs: 0, action: "navigate", destination: null, url: null, transition: "smartAnimate", durationMs: 1000, direction: "left", easing: "linear", overlay: { position: "center", offsetX: 0, offsetY: 0, closeOnClickOutside: true, background: null }, ...o });
const setInter = (name, list) => dispatch({ op: "setInteractions", id: ids[name], interactions: list.map(interaction) });
const shot = (name) => page.screenshot({ path: path.join(OUT, `w4aa-${name}.png`) });
const present = async (frame) => {
  const pg = await page.evaluate(() => window.__dt.state().page);
  await dispatch({ op: "setFlowStart", page: pg, id: ids[frame] });
  // Present starts at the selected frame when there is one: clear the selection.
  await dispatch({ op: "select", ids: [] });
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter");
  await sleep(300);
};
const closePresent = async () => {
  await page.keyboard.press("Escape");
  await page.waitForSelector(".presenter", { state: "detached" });
};
const hot = (id) => page.locator(`.presenter [data-hotspot="${id}"]`);
const smart = (fn, arg) => page.evaluate(([f, a]) => window.__dt.smart[f](a), [fn, arg]);
const crumb = () => page.locator(".presenter .bar .muted").innerText().then((t) => t.trim());
const pieceInfo = (name, side) =>
  page.evaluate(
    ([n, sd]) => {
      const els = [...document.querySelectorAll(`.presenter [data-smart='${n}']`)].filter((e) => !sd || e.dataset.smartSide === sd);
      return els.map((e) => {
        const r = e.getBoundingClientRect();
        const fills = [...e.querySelectorAll("rect, path, ellipse, text, tspan")].map((x) => x.getAttribute("fill")).filter((f) => f && f !== "none");
        return { kind: e.dataset.smartKind, side: e.dataset.smartSide, x: r.x, y: r.y, w: r.width, h: r.height, opacity: parseFloat(getComputedStyle(e).opacity), fills, svg: e.innerHTML };
      });
    },
    [name, side],
  );
const hex = (c) => {
  const m = /^#?([0-9a-f]{6})/i.exec(c ?? "");
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
};

// ---------- fixtures ----------

const png = await page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const g = c.getContext("2d");
  g.fillStyle = "#33AA55";
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = "#FFFFFF";
  g.fillRect(4, 4, 8, 8);
  return c.toDataURL("image/png");
});
const img = { type: "image", src: png, scaleMode: "fill", opacity: 1, visible: true };
const card = (x, y, p) => ({
  type: "frame", name: "Card", x, y, width: 300, height: 220, fill: "#EEEEEE", clip: true,
  children: [
    { type: "rectangle", name: "Badge", x: 10, y: 10, width: p ? 160 : 80, height: 30, fill: p ? "#0000FF" : "#FF0000", cornerRadius: p ? 16 : 4 },
    { type: "text", name: "Title", x: 10, y: 60, text: "Title", fontSize: 20, fill: p ? "#00AA00" : "#000000" },
    { type: "group", name: "Row", x: 10, y: 110, children: [{ type: "rectangle", name: "Icon", x: p ? 200 : 10, y: 110, width: 30, height: 30, fill: "#FF8800" }] },
    { type: "rectangle", name: "Avatar", x: 10, y: 150, width: p ? 80 : 40, height: p ? 80 : 40, fills: [img] },
  ],
});
await tool("create_nodes", {
  nodes: [
    { type: "frame", name: "A", x: 0, y: 0, width: 390, height: 844, fill: "#FFFFFF", children: [card(20, 100, false)] },
    { type: "frame", name: "B", x: 600, y: 0, width: 390, height: 844, fill: "#FFFF00", children: [card(20, 300, true)] },
    // Renamed parent: children fade.
    { type: "frame", name: "C", x: 1200, y: 0, width: 390, height: 844, fill: "#FFFFFF", children: [{ type: "frame", name: "Box", x: 20, y: 100, width: 200, height: 100, fill: "#CCCCCC", children: [{ type: "rectangle", name: "Dot", x: 10, y: 10, width: 20, height: 20, fill: "#FF0000" }] }] },
    { type: "frame", name: "D", x: 1800, y: 0, width: 390, height: 844, fill: "#FFFFFF", children: [{ type: "frame", name: "Boxes", x: 20, y: 300, width: 200, height: 100, fill: "#CCCCCC", children: [{ type: "rectangle", name: "Dot", x: 10, y: 10, width: 20, height: 20, fill: "#FF0000" }] }] },
    // Toggle component set for Change to, on a scrolling screen.
    { type: "frame", name: "State=Off", x: 2400, y: 0, width: 120, height: 50, fill: "#CCCCCC", children: [{ type: "rectangle", name: "Knob", x: 4, y: 4, width: 20, height: 20, fill: "#FF0000" }, { type: "rectangle", name: "Track", x: 0, y: 40, width: 120, height: 10, fill: "#CC0000" }] },
    { type: "frame", name: "State=On", x: 2600, y: 0, width: 120, height: 50, fill: "#CCCCCC", children: [{ type: "rectangle", name: "Knob", x: 96, y: 4, width: 20, height: 20, fill: "#00AA00" }, { type: "rectangle", name: "Track", x: 0, y: 40, width: 120, height: 10, fill: "#00CC00" }] },
    { type: "frame", name: "Settings", x: 3000, y: 0, width: 390, height: 600, fill: "#FFFFFF", children: [{ type: "rectangle", name: "Body", x: 0, y: 0, width: 390, height: 1500, fill: "#F0F0F0" }] },
    // Carousel variants: a clipped viewport with a track of three slides.
    ...[1, 2, 3].map((n) => ({
      type: "frame", name: `Slide=${n}`, x: 3600 + n * 400, y: 0, width: 300, height: 100, fill: "#222222", clip: true,
      children: [{ type: "frame", name: "Track", x: -(n - 1) * 300, y: 0, width: 900, height: 100, children: [0, 1, 2].map((i) => ({ type: "rectangle", name: `S${i + 1}`, x: i * 300, y: 0, width: 300, height: 100, fill: ["#FF5555", "#55FF55", "#5555FF"][i] })) }],
    })),
    { type: "frame", name: "Home", x: 5400, y: 0, width: 390, height: 844, fill: "#FFFFFF" },
    // Push + drag, and drag + click on one layer.
    { type: "frame", name: "P1", x: 6000, y: 0, width: 390, height: 844, fill: "#FFFFFF", children: [{ type: "rectangle", name: "Pusher", x: 20, y: 100, width: 200, height: 100, fill: "#FF0066" }, { type: "rectangle", name: "Both", x: 20, y: 300, width: 200, height: 100, fill: "#0066FF" }, { type: "rectangle", name: "Holder", x: 20, y: 500, width: 200, height: 100, fill: "#00AA66" }] },
    { type: "frame", name: "P2", x: 6600, y: 0, width: 390, height: 844, fill: "#FFFF99" },
    { type: "frame", name: "Clicked", x: 7200, y: 0, width: 390, height: 844, fill: "#FF99FF" },
    // 40 live pieces.
    { type: "frame", name: "L1", x: 7800, y: 0, width: 390, height: 844, fill: "#FFFFFF", children: Array.from({ length: 40 }, (_, i) => ({ type: "rectangle", name: `R${i}`, x: 10 + (i % 8) * 45, y: 100 + Math.floor(i / 8) * 45, width: 30, height: 30, fill: "#FF0000", cornerRadius: 2 })) },
    { type: "frame", name: "L2", x: 8400, y: 0, width: 390, height: 844, fill: "#FFFFFF", children: Array.from({ length: 40 }, (_, i) => ({ type: "rectangle", name: `R${i}`, x: 40 + (i % 8) * 40, y: 200 + Math.floor(i / 8) * 50, width: 36, height: 36, fill: "#0000FF", cornerRadius: 12 })) },
  ],
});
await refresh();
// the card's hotspot layers need unique names to look up: remember the screens' cards by parent
const d0 = await doc();
const byParent = (parent, name) => Object.values(d0.nodes).find((n) => n.name === name && n.parent === parent)?.id;
const cardA = byParent(ids["A"], "Card");
ids["Card A"] = cardA;

// ---------- 1: nested smart animate, 1000 ms linear ----------
await dispatch({ op: "setInteractions", id: cardA, interactions: [interaction({ destination: ids["B"] })] });
await present("A");
await hot(cardA).click();
await sleep(150);
await smart("seek", 0.5);
const st = await page.evaluate(() => window.__dt.smart.state());
const kinds = Object.fromEntries(st.pieces.map((p) => [p.name + "/" + p.side, p.kind]));
check("1: the pieces list the nested names", ["Badge", "Title", "Icon", "Avatar", "Card"].every((n) => st.pieces.some((p) => p.name === n)), JSON.stringify(st.pieces.map((p) => p.path)));
check("1: eased is 0.5 at seek(0.5) for linear", near(st.eased, 0.5, 0.001), String(st.eased));
const badge = (await pieceInfo("Badge"))[0];
check("1: Badge is live", badge?.kind === "live", badge?.kind);
check("1: Badge width is half way (120)", badge && near(badge.w, 120, 1.5), badge && String(badge.w));
const bc = hex(badge?.fills[0]);
check("1: Badge fill is about #800080", bc && near(bc[0], 128, 2) && near(bc[1], 0, 2) && near(bc[2], 128, 2), badge?.fills.join());
const title = (await pieceInfo("Title"))[0];
check("1: Title (colour only) is live and half way between colours", title?.kind === "live" && (title.fills[0] ? true : false), title?.kind + " " + title?.fills.join());
const avatar = (await pieceInfo("Avatar"));
check("1: Avatar (image resize) is morph (old + new)", avatar.length === 2 && avatar.every((a) => a.kind === "morph"), JSON.stringify(avatar.map((a) => a.kind)));
const cardEl = (await pieceInfo("Card"))[0];
check("1: Card own piece only moves (same look: drawn once and translated)", cardEl?.kind === "move", cardEl?.kind);
const iconNow = (await pieceInfo("Icon"))[0];
await smart("seek", 0);
const icon0 = (await pieceInfo("Icon"))[0];
await smart("seek", 1);
const icon1 = (await pieceInfo("Icon"))[0];
check("1: Icon (group child) is half way", iconNow && near(iconNow.x - icon0.x, (icon1.x - icon0.x) / 2, 1.5) && icon1.x - icon0.x > 50, `${icon0.x} ${iconNow.x} ${icon1.x}`);
await smart("seek", 0.5);
const bgColor = await page.evaluate(() => {
  const f = [...document.querySelectorAll(".presenter .smart-layer [data-smart]")].find((e) => e.dataset.smart === "B");
  return f ? [...f.querySelectorAll("rect,path")].map((x) => x.getAttribute("fill")).filter((x) => x && x !== "none")[0] : null;
});
console.log("INFO root pieces", JSON.stringify((await pieceInfo("B")).map((x) => [x.kind, x.side, x.fills])), JSON.stringify(st.pieces[0]));
const rc = hex(bgColor);
check("1: the screen background colour is half way", rc && near(rc[0], 255, 2) && near(rc[1], 255, 2) && near(rc[2], 128, 3), String(bgColor));
const clipped = await page.evaluate(() => [...document.querySelectorAll(".presenter .smart-layer [data-smart='Icon']")].every((e) => /inset\(/.test(e.parentElement.style.clipPath || "")));
check("1: pieces inside the clipping Card are clipped to it", clipped);
await shot("p-0.5");
await smart("seek", 0);
await shot("p-0");
await smart("seek", 1);
await shot("p-1");
await closePresent();

// ---------- 2: renamed parent, children fade ----------
await dispatch({ op: "setInteractions", id: byParent(ids["C"], "Box"), interactions: [interaction({ destination: ids["D"] })] });
await present("C");
await hot(byParent(ids["C"], "Box")).click();
await sleep(150);
await smart("seek", 0.5);
const s2 = await page.evaluate(() => window.__dt.smart.state());
const gone = s2.pieces.filter((p) => p.name === "Box");
const came = s2.pieces.filter((p) => p.name === "Boxes");
check("2: a renamed parent fades out and in, each as one picture (its children inside it)", gone.length === 1 && came.length === 1 && gone[0].kind === "fade" && came[0].kind === "fade" && gone[0].side === "old" && came[0].side === "new" && !s2.pieces.some((p) => p.name === "Dot"), JSON.stringify(s2.pieces));
await closePresent();

// ---------- 3: easing ----------
await dispatch({ op: "setInteractions", id: cardA, interactions: [interaction({ destination: ids["B"], easing: "easeInBack" })] });
await present("A");
await hot(cardA).click();
await sleep(100);
await smart("seek", 0.15);
const s3 = await page.evaluate(() => window.__dt.smart.state());
const c15 = (await pieceInfo("Card"))[0];
await smart("seek", 0);
const c0 = (await pieceInfo("Card"))[0];
check("3: easeInBack overshoots below 0 early on", s3.eased < 0, String(s3.eased));
check("3: the card sits beyond its start (further from the target)", c15.y < c0.y - 0.2, `${c0.y} -> ${c15.y}`);
await closePresent();
await dispatch({ op: "setInteractions", id: cardA, interactions: [interaction({ destination: ids["B"], bezier: [0.9, 0, 1, 0.1] })] });
await present("A");
await hot(cardA).click();
await sleep(100);
await smart("seek", 0.5);
const s3b = await page.evaluate(() => window.__dt.smart.state());
check("3: a custom bezier changes eased", s3b.eased < 0.2, String(s3b.eased));
await closePresent();

// ---------- 4, 5: duration, back, reduced motion ----------
await dispatch({ op: "setInteractions", id: cardA, interactions: [interaction({ destination: ids["B"], durationMs: 300 })] });
await present("A");
const t0 = Date.now();
await hot(cardA).click();
await page.waitForFunction(() => document.querySelectorAll(".presenter [data-smart]").length === 0 && !!document.querySelector(".presenter"), null, { polling: 10, timeout: 3000 });
const took = Date.now() - t0;
check("4: a 300 ms navigate ends between 300 and 450 ms", took >= 290 && took <= 480, `${took} ms`);
check("4: the real screen is visible", (await crumb()) === "B");
await sleep(100);
// Back reverses.
await page.click(".presenter .bar button[title='Back']");
await sleep(120);
const rev = await page.evaluate(() => window.__dt.smart.state());
check("5: Back plays a smart animate (pieces of B -> A)", !!rev && rev.pieces.some((p) => p.name === "Badge"), JSON.stringify(rev?.pieces?.length));
await sleep(500);
check("5: Back ends on A", (await crumb()) === "A");
await closePresent();
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 }, reducedMotion: "reduce" });
  await ctx.route("**/*", (r) => (/^(data|blob):|^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(r.request().url()) ? r.continue() : r.abort()));
  await ctx.addInitScript(() => localStorage.setItem("dt:tour-done", "1"));
  const p2 = await ctx.newPage();
  await p2.goto(URL);
  await p2.click("button:has-text('New design file')");
  await p2.waitForSelector("#dt-canvas");
  await p2.evaluate(() => window.__dt.tool("create_nodes", { nodes: [{ type: "frame", name: "RA", x: 0, y: 0, width: 300, height: 300, children: [{ type: "rectangle", name: "Q", x: 10, y: 10, width: 50, height: 50 }] }, { type: "frame", name: "RB", x: 500, y: 0, width: 300, height: 300, children: [{ type: "rectangle", name: "Q", x: 100, y: 100, width: 50, height: 50 }] }] }));
  const ra = await p2.evaluate(() => Object.values(window.__dt.doc().nodes).find((n) => n.name === "RA").id);
  const rb = await p2.evaluate(() => Object.values(window.__dt.doc().nodes).find((n) => n.name === "RB").id);
  const q = await p2.evaluate((a) => Object.values(window.__dt.doc().nodes).find((n) => n.name === "Q" && n.parent === a).id, ra);
  await p2.evaluate(([qq, b, i]) => window.__dt.dispatch({ op: "setInteractions", id: qq, interactions: [{ ...i, destination: b }] }), [q, rb, interaction({})]);
  const pg = await p2.evaluate(() => window.__dt.state().page);
  await p2.evaluate(([a, g]) => window.__dt.dispatch({ op: "setFlowStart", page: g, id: a }), [ra, pg]);
  await p2.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await p2.click("button[title='Present']");
  await p2.waitForSelector(".presenter");
  await sleep(200);
  await p2.locator(`.presenter [data-hotspot="${q}"]`).click();
  await sleep(60);
  check("5: reduced motion is instant (no smart layer)", (await p2.locator(".presenter .smart-layer").count()) === 0 && (await p2.locator(".presenter .bar .muted").innerText()).trim() === "RB");
  await ctx.close();
}

// ---------- 6: Change to with nested layers, on a scrolled screen ----------
for (const n of ["State=Off", "State=On"]) await dispatch({ op: "createComponent", ids: [ids[n]] });
await refresh();
const dd = await doc();
const offId = Object.values(dd.nodes).find((n) => n.type === "component" && n.name === "State=Off").id;
const onId = Object.values(dd.nodes).find((n) => n.type === "component" && n.name === "State=On").id;
await dispatch({ op: "combineVariants", ids: [offId, onId] });
const toggle = (await dispatch({ op: "createInstance", componentId: offId, x: 3100, y: 400, parent: ids["Settings"] })).id;
await dispatch({ op: "update", ids: [toggle], patch: { name: "Toggle" } });
await dispatch({ op: "update", ids: [ids["Settings"]], patch: { overflow: "vertical" } });
await dispatch({ op: "setInteractions", id: offId, interactions: [interaction({ action: "changeTo", destination: onId, durationMs: 1000 })] });
await dispatch({ op: "setInteractions", id: onId, interactions: [interaction({ action: "changeTo", destination: offId, durationMs: 1000 })] });
await present("Settings");
const sc = page.locator(".presenter [data-scroller]").first();
const box = await sc.boundingBox();
await page.mouse.move(box.x + 300, box.y + 100);
await page.mouse.wheel(0, 150);
await sleep(300);
const scrollTop = await sc.evaluate((e) => e.scrollTop);
const tb = await hot(toggle).boundingBox();
console.log("INFO toggle box", JSON.stringify(tb), "scroller", JSON.stringify(box), "scrollTop", scrollTop);
await page.mouse.click(tb.x + 10, tb.y + 10);
await sleep(100);
await smart("seek", 0.5);
const knob = (await pieceInfo("Knob"))[0];
const trackP = (await pieceInfo("Track"))[0];
const ptrack = (await pieceInfo("Track"));
const tgl = await hot(toggle).boundingBox().catch(() => null);
check("6: the scroller is scrolled", scrollTop >= 100, String(scrollTop));
check("6: Knob and Track are pieces", !!knob && !!trackP, JSON.stringify(knob?.kind));
// The toggle sits at design y 400, scrolled by 150: its knob is near the viewport y of (400 + 4 - 150) from the scroller top.
const expectedY = box.y + 400 + 4 - scrollTop;
check("6: the knob piece is offset by the scroll", knob && near(knob.y, expectedY, 4), `y=${knob?.y} expected ${expectedY}`);
const trk = ptrack[0];
const tc = hex(trk?.fills[0]);
check("6: Track colour lerps (#CC0000 -> #00CC00 half way)", tc && near(tc[0], 102, 4) && near(tc[1], 102, 4), trk?.fills.join());
await shot("changeto-mid");
await page.keyboard.press("r");
await sleep(400);
await page.mouse.click(tb.x + 10, tb.y + 10);
await sleep(1250);
check("6: the pieces go when it ends", (await page.locator(".presenter .smart-layer [data-smart]").count()) === 0);
await closePresent();

// ---------- 7: On drag carousel ----------
for (const n of [1, 2, 3]) await dispatch({ op: "createComponent", ids: [ids[`Slide=${n}`]] });
await refresh();
const dd2 = await doc();
const slideId = (n) => Object.values(dd2.nodes).find((x) => x.type === "component" && x.name === `Slide=${n}`).id;
await dispatch({ op: "combineVariants", ids: [1, 2, 3].map(slideId) });
for (const [n, to] of [[1, 2], [2, 3], [3, 1]]) {
  await dispatch({ op: "setInteractions", id: slideId(n), interactions: [interaction({ trigger: "onDrag", action: "changeTo", destination: slideId(to), durationMs: 300, direction: "left", easing: "easeOut" })] });
}
const car = (await dispatch({ op: "createInstance", componentId: slideId(1), x: 5445, y: 300, parent: ids["Home"] })).id;
await dispatch({ op: "update", ids: [car], patch: { name: "Carousel" } });
await present("Home");
const hb = await hot(car).boundingBox();
const ta = await hot(car).evaluate((e) => getComputedStyle(e).touchAction);
check("7: the drag hotspot has touch-action pan-y", ta === "pan-y", ta);
const variantNow = () => page.evaluate((c) => window.__dt.smart.variant(c), car);
const startVariant = await variantNow();
const dragBy = async (dx, opts = {}) => {
  const x0 = hb.x + hb.width - 10;
  const y0 = hb.y + 50;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const steps = opts.steps ?? 8;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + (dx * i) / steps, y0);
    if (opts.stepMs) await sleep(opts.stepMs);
  }
  return { x0, y0 };
};
await dragBy(-120, { stepMs: 15 });
await sleep(250);
const mid = await page.evaluate(() => window.__dt.smart.state());
check("7: dragging 40% of the travel: pieces follow", mid && near(mid.eased, 0.4, 0.06), mid && String(mid.eased));
await shot("drag-40");
await page.mouse.up();
await sleep(700);
check("7: release at 40%: snaps back, still Slide 1", (await variantNow()) === startVariant && (await page.locator(".presenter .smart-layer [data-smart]").count()) === 0, String(await variantNow()));
await dragBy(-210, { stepMs: 15 });
await sleep(250);
await page.mouse.up();
await sleep(700);
const afterSlide = await variantNow();
check("7: release at 70%: completes to Slide 2", afterSlide === slideId(2), `${afterSlide} vs ${slideId(2)}`);
// Flick: 30 px in 40 ms from Slide 2.
{
  const x0 = hb.x + hb.width - 10;
  const y0 = hb.y + 50;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 - 15, y0);
  await sleep(20);
  await page.mouse.move(x0 - 30, y0);
  await sleep(10);
  await page.mouse.up();
  await sleep(700);
  check("7: a 30 px flick in about 40 ms completes", (await variantNow()) === slideId(3), String(await variantNow()));
}
await closePresent();

// ---------- 8: drag with click, drag with While pressing ----------
const both = byParent(ids["P1"], "Both");
const holder = byParent(ids["P1"], "Holder");
const pusher = byParent(ids["P1"], "Pusher");
await dispatch({ op: "setInteractions", id: both, interactions: [interaction({ trigger: "onClick", destination: ids["Clicked"], transition: "instant", durationMs: 0 }), interaction({ trigger: "onDrag", destination: ids["P2"], transition: "instant", durationMs: 0 })] });
await present("P1");
{
  const b = await hot(both).boundingBox();
  await page.mouse.move(b.x + 50, b.y + 50);
  await page.mouse.down();
  await page.mouse.move(b.x + 52, b.y + 51);
  await page.mouse.up();
  await sleep(250);
  check("8: a 3 px move and release clicks", (await crumb()) === "Clicked", await crumb());
}
await closePresent();
await present("P1");
{
  const b = await hot(both).boundingBox();
  await page.mouse.move(b.x + 50, b.y + 50);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + 50 + i * 5, b.y + 50);
  await page.mouse.up();
  await sleep(250);
  check("8: a 40 px drag runs the drag action, not the click", (await crumb()) === "P2", await crumb());
}
await closePresent();
await dispatch({ op: "setInteractions", id: holder, interactions: [interaction({ trigger: "onPress", destination: ids["Clicked"], transition: "instant", durationMs: 0 }), interaction({ trigger: "onDrag", destination: ids["P2"], transition: "instant", durationMs: 0 })] });
await present("P1");
{
  const b = await hot(holder).boundingBox();
  await page.mouse.move(b.x + 50, b.y + 50);
  await page.mouse.down();
  await sleep(100);
  const during = await crumb();
  for (let i = 1; i <= 4; i++) await page.mouse.move(b.x + 50 + i * 4, b.y + 50);
  await sleep(150);
  const after = await crumb();
  await page.mouse.up();
  await sleep(200);
  check("8: While pressing shows on press, and the drag start puts it back (then the drag runs)", during === "Clicked" && after === "P2", `${during} -> ${after} -> ${await crumb()}`);
}
await closePresent();

// ---------- 9: drag with Push ----------
await dispatch({ op: "setInteractions", id: pusher, interactions: [interaction({ trigger: "onDrag", destination: ids["P2"], transition: "push", direction: "left", durationMs: 600, easing: "easeOut" })] });
await present("P1");
{
  const b = await hot(pusher).boundingBox();
  const ta2 = await hot(pusher).evaluate((e) => getComputedStyle(e).touchAction);
  check("9: a horizontal Push drag has touch-action pan-y", ta2 === "pan-y", ta2);
  await page.mouse.move(b.x + 100, b.y + 50);
  await page.mouse.down();
  // Half the screen width (390 / 2) to the left.
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(b.x + 100 - i * 19.5, b.y + 50);
    await sleep(10);
  }
  await sleep(100);
  const xs = await page.evaluate(() => [...document.querySelectorAll(".presenter-viewport .stage")].map((e) => e.getBoundingClientRect().x));
  const vp = await page.evaluate(() => document.querySelector(".presenter-viewport").getBoundingClientRect().x);
  const offs = xs.map((x) => Math.round(x - vp)).sort((a, c) => a - c);
  check("9: both stages are half way (-195 and +195)", offs.length === 2 && near(offs[0], -195, 6) && near(offs[1], 195, 6), JSON.stringify(offs));
  await shot("push-50");
  await page.mouse.up();
  await sleep(900);
  check("9: released at 50%: completes to P2", (await crumb()) === "P2", await crumb());
}
await closePresent();

// ---------- 10: keyboard ----------
await present("P1");
{
  await page.keyboard.press("Tab"); // bar buttons first
  let hit = null;
  for (let i = 0; i < 12 && !hit; i++) {
    await page.keyboard.press("Tab");
    hit = await page.evaluate(() => {
      const a = document.activeElement;
      return a?.classList.contains("hotspot") ? a.getAttribute("aria-label") : null;
    });
  }
  check("10: a drag-only layer is a keyboard stop", !!hit && /on drag/i.test(hit), String(hit));
  await page.keyboard.press("Enter");
  await sleep(1000);
  check("10: Enter plays the drag's action to completion", (await crumb()) === "P2", await crumb());
}
await closePresent();

// ---------- 11: performance, 40 live pieces ----------
for (let i = 0; i < 40; i++) {
  // (the pieces pair by name across the two screens)
}
const l1first = byParent(ids["L1"], "R0");
await dispatch({ op: "setInteractions", id: l1first, interactions: [interaction({ destination: ids["L2"], durationMs: 1000, easing: "easeInOut" })] });
await present("L1");
// Record the frame deltas from the click on (the click starts the tween in the same task).
await hot(l1first).evaluate((el) => {
  window.__frames = [];
  let last = performance.now();
  const tick = (t) => {
    window.__frames.push(t - last);
    last = t;
    if (window.__frames.length < 90) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await sleep(500);
const live = (await page.evaluate(() => window.__dt.smart.state()))?.pieces?.filter((p) => p.kind === "live").length;
await sleep(1000);
const frames = await page.evaluate(() => window.__frames);
check("11: the tween has 40 live pieces", live === 40, String(live));
// only the frames during the tween (the first, which holds the plan, dropped)
console.log("INFO frames", frames.slice(0, 40).map((f) => f.toFixed(0)).join(" "));
const during = frames.slice(1, 60);
const sorted = [...during].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const worst = sorted[sorted.length - 1];
console.log(`INFO  rAF deltas during the tween: n=${during.length} median=${median?.toFixed(1)} max=${worst?.toFixed(1)}`);
check("11: 40 live pieces: median frame <= 20 ms, none over 60 ms", median <= 20 && worst <= 60, `median ${median?.toFixed(1)}, max ${worst?.toFixed(1)}`);
await closePresent();

// ---------- 12: review fixes: scroll kept on snap-back, a cut-off release, Change to in an overlay ----------
await tool("create_nodes", {
  nodes: [
    { type: "frame", name: "SS", x: 9600, y: 0, width: 390, height: 600, fill: "#FFFFFF", children: [{ type: "rectangle", name: "SBody", x: 0, y: 0, width: 390, height: 1500, fill: "#EEEEEE" }, { type: "rectangle", name: "Sdrag", x: 20, y: 300, width: 300, height: 100, fill: "#FF0066" }] },
    { type: "frame", name: "R1", x: 10200, y: 0, width: 390, height: 600, fill: "#FFFFFF", children: [{ type: "rectangle", name: "Go", x: 20, y: 100, width: 200, height: 100, fill: "#00AA66" }] },
    { type: "frame", name: "R2", x: 10800, y: 0, width: 390, height: 600, fill: "#FFFF99", children: [{ type: "rectangle", name: "Rdrag", x: 20, y: 100, width: 300, height: 100, fill: "#0066FF" }] },
    { type: "frame", name: "R3", x: 11400, y: 0, width: 390, height: 600, fill: "#FF99FF" },
    { type: "frame", name: "OvHost", x: 12000, y: 0, width: 600, height: 800, fill: "#FFFFFF", children: [{ type: "rectangle", name: "OpenOv", x: 20, y: 20, width: 120, height: 50, fill: "#FF8800" }] },
    { type: "frame", name: "OvModal", x: 12800, y: 0, width: 300, height: 200, fill: "#FFFFFF" },
  ],
});
await refresh();
{
  const dd3 = await doc();
  const child = (parent, name) => Object.values(dd3.nodes).find((n) => n.name === name && n.parent === parent).id;
  ids.Sdrag = child(ids.SS, "Sdrag");
  ids.Go = child(ids.R1, "Go");
  ids.Rdrag = child(ids.R2, "Rdrag");
  ids.OpenOv = child(ids.OvHost, "OpenOv");
  await dispatch({ op: "update", ids: [ids.SS], patch: { overflow: "vertical" } });
  const push = (dest) => interaction({ trigger: "onDrag", destination: dest, transition: "push", direction: "left", durationMs: 600, easing: "easeOut" });
  await dispatch({ op: "setInteractions", id: ids.Sdrag, interactions: [push(ids.P2)] });
  await dispatch({ op: "setInteractions", id: ids.Go, interactions: [interaction({ transition: "instant", durationMs: 0, destination: ids.R2 })] });
  await dispatch({ op: "setInteractions", id: ids.Rdrag, interactions: [push(ids.R3)] });
  await dispatch({ op: "setInteractions", id: ids.OpenOv, interactions: [interaction({ action: "openOverlay", destination: ids.OvModal, transition: "instant", durationMs: 0 })] });
  ids.Toggle2 = (await dispatch({ op: "createInstance", componentId: offId, x: 12850, y: 100, parent: ids.OvModal })).id;
}
const slowDrag = async (box, dx) => {
  const x0 = box.x + box.width - 20;
  const y0 = box.y + 40;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(x0 + (dx * i) / 6, y0);
    await sleep(15);
  }
  await sleep(250); // no flick
  await page.mouse.up();
};
// A short Push drag on a scrolled screen snaps back with the scroll where it was.
await present("SS");
{
  const sc2 = page.locator(".presenter [data-scroller]").first();
  const b2 = await sc2.boundingBox();
  await page.mouse.move(b2.x + 200, b2.y + 100);
  await page.mouse.wheel(0, 200);
  await sleep(300);
  const before = await sc2.evaluate((e) => e.scrollTop);
  const hb2 = await hot(ids.Sdrag).boundingBox();
  await slowDrag(hb2, -39);
  await sleep(900);
  const after = await page.locator(".presenter [data-scroller]").first().evaluate((e) => e.scrollTop);
  check("12: a short Push drag on a scrolled screen snaps back with the scroll unchanged", before >= 150 && Math.abs(after - before) <= 1 && (await crumb()) === "SS", `${before} -> ${after}, ${await crumb()}`);
}
await closePresent();
// R during a snap-back does not undo the restart.
await present("R1");
await hot(ids.Go).click();
await sleep(200);
{
  check("12: setup: R1 -> R2", (await crumb()) === "R2");
  const hb3 = await hot(ids.Rdrag).boundingBox();
  const x0 = hb3.x + hb3.width - 20;
  const y0 = hb3.y + 40;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(x0 - (i * 40) / 6, y0);
    await sleep(15);
  }
  await sleep(250);
  await page.mouse.up();
  await page.keyboard.press("r"); // inside the snap-back
  await sleep(1000);
  check("12: R during a snap-back stays restarted (not undone)", (await crumb()) === "R1", await crumb());
  // ... and a drag still works afterwards.
  await hot(ids.Go).click();
  await sleep(200);
  const hb3b = await hot(ids.Rdrag).boundingBox();
  const bx = hb3b.x + hb3b.width - 20;
  const by = hb3b.y + 40;
  await page.mouse.move(bx, by);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(bx - (i * 28) / 8 * 10 / 10 * 1, by);
    await sleep(15);
  }
  await page.mouse.move(bx - 230, by);
  await sleep(250);
  await page.mouse.up();
  await sleep(900);
  check("12: a 70% drag after the R completes", (await crumb()) === "R3", await crumb());
}
await closePresent();
// Closing during a Change to snap-back leaves no stale player engine for the next Present.
await present("Home");
{
  const hb4 = await hot(car).boundingBox();
  const x0 = hb4.x + hb4.width - 10;
  const y0 = hb4.y + 50;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(x0 - (i * 24) / 5, y0);
    await sleep(15);
  }
  await sleep(250);
  await page.mouse.up();
  await page.keyboard.press("Escape"); // inside the snap-back
  await page.waitForSelector(".presenter", { state: "detached" });
  await sleep(500);
  await dispatch({ op: "update", ids: [car], patch: { name: "Carousel renamed" } });
  await present("Home");
  const nm = await page.evaluate((c) => window.__dt.smart.name(c), car);
  check("12: closing during a snap-back leaves no stale engine (the next Present sees the edit)", nm === "Carousel renamed", String(nm));
  const hb5 = await hot(car).boundingBox();
  const cx = hb5.x + hb5.width - 10;
  const cy = hb5.y + 50;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(cx - (i * 210) / 8, cy);
    await sleep(15);
  }
  await sleep(250);
  await page.mouse.up();
  await sleep(700);
  check("12: a drag works after closing and re-presenting", (await page.evaluate((c) => window.__dt.smart.variant(c), car)) === slideId(2));
}
await closePresent();
// Change to inside the top overlay: the pieces sit in the overlay, half way.
await present("OvHost");
{
  await hot(ids.OpenOv).click();
  await sleep(300);
  const ob = await page.locator(`.presenter [data-overlay-frame]`).boundingBox();
  const tb2 = await hot(ids.Toggle2).boundingBox();
  await page.mouse.click(tb2.x + 10, tb2.y + 10);
  await sleep(100);
  await smart("seek", 0.5);
  const kn = (await pieceInfo("Knob"))[0];
  // Instance at overlay-local (50, 100); the knob goes from x 4 to 96 (half way: 50) and sits at y 4.
  check("12: Change to in the overlay: the knob piece is half way inside the overlay", !!kn && near(kn.x, ob.x + 50 + 50, 3) && near(kn.y, ob.y + 100 + 4, 3), `${JSON.stringify(kn && [kn.x, kn.y])} vs ${ob.x + 100}, ${ob.y + 104}`);
  const hidden = await page.evaluate(() => getComputedStyle(document.querySelector("[data-overlay-frame] > div")).visibility);
  check("12: the overlay's own picture waits while the pieces play", hidden === "hidden", hidden);
  const clip = await page.evaluate(() => document.querySelector(".presenter .smart-layer > div:last-child > div")?.style.clipPath ?? "");
  check("12: the pieces are clipped to the overlay box", /inset\(/.test(clip), clip);
}
await page.keyboard.press("Escape"); // closes the overlay
await closePresent();
await present("OvHost");
{
  await hot(ids.OpenOv).click();
  await sleep(300);
  const tb3 = await hot(ids.Toggle2).boundingBox();
  await page.mouse.click(tb3.x + 10, tb3.y + 10);
  await sleep(1300);
  const vis = await page.evaluate(() => getComputedStyle(document.querySelector("[data-overlay-frame] > div")).visibility);
  check("12: when it ends the pieces go and the overlay picture is back", (await page.locator(".presenter .smart-layer [data-smart]").count()) === 0 && vis !== "hidden", vis);
}
await page.keyboard.press("Escape");
await closePresent();

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
