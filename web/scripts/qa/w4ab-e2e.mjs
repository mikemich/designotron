// W4A-B: sticky scrolling in the player and in exported code, background blur behind fixed and
// sticky layers, the panel (Position, On drag, Custom bezier), MCP, collab with older editors and
// an older relay, and On drag as a swipe in an exported project.
// Servers (all local):
//   E2E_URL    vite preview of web/dist (default http://127.0.0.1:7311)
//   E2E_EXPORT port for the exported HTML (default 7312)
//   E2E_BRIDGE bridge URL serving web/dist (default http://127.0.0.1:7315, started with
//              CLAUDE_BIN=web/scripts/fixtures/fake-claude.mjs ... --no-open); its LAN share listener is port + 1
//   E2E_RELAY / E2E_RELAY_OLD   a relay of this build (default http://127.0.0.1:7317) and one built
//              from ead5ada (default http://127.0.0.1:7318)
//   E2E_DEPS   a folder with node_modules for the exported React project (without it the swipe step is skipped)
//   SHOTS      folder for screenshots
import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const URL_ = process.env.E2E_URL ?? "http://127.0.0.1:7311";
const EXPORT_PORT = Number(process.env.E2E_EXPORT ?? 7312);
const BRIDGE = process.env.E2E_BRIDGE ?? "http://127.0.0.1:7315";
const RELAY = process.env.E2E_RELAY ?? "http://127.0.0.1:7317";
const RELAY_OLD = process.env.E2E_RELAY_OLD ?? "http://127.0.0.1:7318";
const SHOTS = process.env.SHOTS;
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 500) : ""}`);
};
const local = (u) => /^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) || /^(data|blob|about):/.test(u);

const browser = await chromium.launch(launch);
const errors = [];
const newPage = async (opts = {}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...opts });
  await context.route((u) => !local(u.toString()), (r) => r.abort());
  await context.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  return page;
};
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const tool = (page, name, input) => page.evaluate(([n, i]) => window.__dt.dispatch({ op: "ai", tool: n, input: i }), [name, input]);
const ids = (r) => Object.fromEntries(r.created.map((c) => [c.name, c.id]));
const open = async (page, url = URL_) => {
  await page.goto(url);
  await page.waitForSelector(".files", { timeout: 20000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas", { timeout: 20000 });
  await page.waitForTimeout(300);
};
const nodeId = (page, name) => page.evaluate((n) => Object.values(window.__dt.doc().nodes).find((x) => x.name === n)?.id, name);
const setStart = (page, id) =>
  page.evaluate((f) => {
    const d = window.__dt.doc();
    const pg = Object.values(d.pages).find((p) => p.children.includes(f)) ?? Object.values(d.pages)[0];
    window.__dt.dispatch({ op: "setFlowStart", page: pg.id, id: f });
  }, id);
const present = async (page) => {
  await page.click("button[title^='Present (']");
  await page.waitForSelector(".presenter");
  await page.waitForTimeout(500);
};
const leave = async (page) => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
};
const crumb = (page) => page.locator(".presenter .bar .muted").first().innerText().then((t) => t.trim());
/** Top of `sel` relative to the top of the scroller, in design px (the player scales to fit the window). */
const topIn = (page, sel, designHeight = 844) =>
  page.evaluate(([s, h]) => {
    const sc = document.querySelector(".presenter [data-scroller]").getBoundingClientRect();
    const el = document.querySelector(s);
    return el ? ((el.getBoundingClientRect().top - sc.top) * h) / sc.height : null;
  }, [sel, designHeight]);
const scrollTo = async (page, top) => {
  await page.evaluate((t) => (document.querySelector(".presenter [data-scroller]").scrollTop = t), top);
  await page.waitForTimeout(150);
};

try {
  // ---- 1. Sticky header in the player ----
  {
    const page = await newPage();
    await open(page);
    // Home 390x844 scrolls; Section A (600 tall) holds the sticky header at y 300; Badge is a later sibling.
    const r = await tool(page, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Home", x: 0, y: 0, width: 390, height: 844, fill: "#FFFFFF", overflow: "vertical",
          children: [
            {
              type: "frame", name: "Section A", x: 0, y: 0, width: 390, height: 600, fill: "#F1F5F9", clip: true,
              children: [
                { type: "rectangle", name: "Header", x: 0, y: 300, width: 390, height: 48, fill: "#2563EB", scrollBehavior: "sticky" },
                { type: "rectangle", name: "Badge", x: 300, y: 310, width: 40, height: 40, fill: "#DC2626" },
              ],
            },
            { type: "frame", name: "Section B", x: 0, y: 600, width: 390, height: 900, fill: "#E2E8F0", children: [{ type: "text", name: "B text", text: "Section B", x: 20, y: 20, fontSize: 20 }] },
          ],
        },
        { type: "frame", name: "Other", x: 600, y: 0, width: 390, height: 844, fill: "#DCFCE7", children: [{ type: "text", name: "Other text", text: "Other screen", x: 20, y: 20, fontSize: 20 }] },
      ],
    });
    const m = ids(r);
    const header = await nodeId(page, "Header");
    const badge = await nodeId(page, "Badge");
    await tool(page, "set_prototype", { nodeId: header, action: "navigate", destinationId: m.Other });
    await tool(page, "set_prototype", { nodeId: badge, action: "back" });
    await setStart(page, m.Home);
    await present(page);
    check("the header is a sticky layer (data-sticky)", (await page.locator(`.presenter [data-sticky="${header}"]`).count()) === 1);
    const at = async (s) => {
      await scrollTo(page, s);
      return topIn(page, `.presenter [data-sticky="${header}"]`);
    };
    const t0 = await at(0);
    const t200 = await at(200);
    const t400 = await at(400);
    const t520 = await at(520);
    const t700 = await at(640);
    check("scroll 0: header at its design y (300)", Math.abs(t0 - 300) <= 1, t0);
    check("scroll 200: header at 100", Math.abs(t200 - 100) <= 1, t200);
    check("scroll 400: header stuck at 0", Math.abs(t400) <= 1, t400);
    check("scroll 520: still stuck at 0", Math.abs(t520) <= 1, t520);
    check("past the section end it leaves with its parent (600 - 48 - 640 = -88)", Math.abs(t700 - -88) <= 1, t700);
    await scrollTo(page, 400);
    await shot(page, "sticky-stuck");
    // A click on the stuck header runs its link.
    const hs = await page.locator(`.presenter [data-hotspot="${header}"]`).first().boundingBox();
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute("data-hotspot"), [hs.x + 20, hs.y + hs.height / 2]);
    check("the stuck header's hotspot is under the pointer", hit === header, hit);
    await page.mouse.click(hs.x + 20, hs.y + hs.height / 2);
    await page.waitForTimeout(600);
    check("clicking the stuck header navigates", (await crumb(page)).includes("Other"), await crumb(page));
    await leave(page);
    await present(page);
    // The Badge is painted after the header: it covers it where they overlap, and scrolls away while it sticks.
    await scrollTo(page, 0);
    const over = await page.evaluate(
      ([bid]) => {
        const b = document.querySelector(`.presenter [data-hotspot="${bid}"]`).getBoundingClientRect();
        return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.getAttribute("data-hotspot");
      },
      [badge],
    );
    check("the later Badge covers the header", over === badge, over);
    await scrollTo(page, 400);
    const away = await page.evaluate(
      ([bid]) => {
        const b = document.querySelector(`.presenter [data-hotspot="${bid}"]`).getBoundingClientRect();
        const sc = document.querySelector(".presenter [data-scroller]").getBoundingClientRect();
        return b.bottom < sc.top + 1;
      },
      [badge],
    );
    check("the Badge scrolls off while the header stays", away);
    await leave(page);
    await page.context().close();
  }

  // ---- 2. Horizontal-only scroller: sticky scrolls ----
  {
    const page = await newPage();
    await open(page);
    const r = await tool(page, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Row", x: 0, y: 0, width: 390, height: 400, fill: "#FFFFFF", overflow: "horizontal",
          children: [
            { type: "rectangle", name: "Tab", x: 20, y: 20, width: 80, height: 40, fill: "#2563EB", scrollBehavior: "sticky" },
            { type: "rectangle", name: "Wide", x: 0, y: 100, width: 1000, height: 200, fill: "#E2E8F0" },
          ],
        },
      ],
    });
    await setStart(page, ids(r).Row);
    await present(page);
    check("sticky in a horizontal-only scroller is not sticky", (await page.locator(".presenter [data-sticky]").count()) === 0);
    const before = await page.evaluate(() => document.querySelector(".presenter [data-scroller]").scrollWidth);
    check("the row scrolls sideways", before > 390, before);
    await leave(page);
    await page.context().close();
  }

  // ---- 2b. A sticky layer after a carousel is drawn once ----
  {
    const page = await newPage();
    await open(page);
    const r = await tool(page, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Home", x: 0, y: 0, width: 390, height: 844, fill: "#FFFFFF", overflow: "vertical",
          children: [
            { type: "frame", name: "Carousel", x: 0, y: 0, width: 390, height: 120, fill: "#E2E8F0", overflow: "horizontal", children: [{ type: "rectangle", name: "Slides", x: 0, y: 0, width: 1000, height: 120, fill: "#94A3B8" }] },
            { type: "rectangle", name: "Tabs", x: 0, y: 140, width: 390, height: 48, fill: "#FF00AA", scrollBehavior: "sticky" },
            { type: "frame", name: "List", x: 0, y: 200, width: 390, height: 1500, fill: "#F8FAFC", children: [{ type: "rectangle", name: "Section", x: 0, y: 600, width: 390, height: 100, fill: "#10B981" }] },
          ],
        },
      ],
    });
    await setStart(page, ids(r).Home);
    await present(page);
    const tabs = await nodeId(page, "Tabs");
    const copies = await page.evaluate(() => (document.querySelector(".presenter").innerHTML.match(/ff00aa/gi) ?? []).length);
    check("carousel, sticky Tabs, list: Tabs is drawn once", copies === 1, copies);
    check("and it is the sticky one", (await page.locator(`.presenter [data-sticky="${tabs}"]`).count()) === 1);
    await scrollTo(page, 300);
    const t = await topIn(page, `.presenter [data-sticky="${tabs}"]`);
    check("Tabs sticks at the top while the list scrolls", Math.abs(t) <= 1, t);
    await shot(page, "sticky-after-carousel");
    await leave(page);
    // The same when the sticky layer sits inside a section that comes after the carousel.
    await tool(page, "update_nodes", { updates: [{ id: tabs, scrollBehavior: "scroll" }] });
    const r2 = await tool(page, "create_nodes", {
      parentId: ids(r).Home,
      nodes: [{ type: "frame", name: "Sec", x: 0, y: 700, width: 390, height: 400, fill: "#FFFFFF", children: [{ type: "rectangle", name: "Tabs2", x: 0, y: 20, width: 390, height: 48, fill: "#00AAFF", scrollBehavior: "sticky" }] }],
    }).catch(() => null);
    if (r2) {
      await present(page);
      const c2 = await page.evaluate(() => (document.querySelector(".presenter").innerHTML.match(/00aaff/gi) ?? []).length);
      check("a sticky layer inside a later section is drawn once", c2 === 1, c2);
      await leave(page);
    }
    await page.context().close();
  }

  // ---- 2c. A later section that holds a carousel must not paint over it ----
  {
    const page = await newPage();
    await open(page);
    const r = await tool(page, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Home", x: 0, y: 0, width: 390, height: 844, fill: "#FFFFFF", overflow: "vertical",
          children: [
            { type: "rectangle", name: "Tabs", x: 0, y: 0, width: 390, height: 48, fill: "#FF00AA", scrollBehavior: "sticky" },
            {
              type: "frame", name: "Section", x: 0, y: 100, width: 390, height: 1400, fill: "#FFFFFF",
              children: [{ type: "frame", name: "Cards", x: 0, y: 50, width: 390, height: 140, fill: "#3344CC", overflow: "horizontal", children: [{ type: "rectangle", name: "Card", x: 0, y: 0, width: 1000, height: 140, fill: "#12AB34" }] }],
            },
          ],
        },
      ],
    });
    await setStart(page, ids(r).Home);
    await present(page);
    const order = await page.evaluate(() => {
      const p = document.querySelector(".presenter");
      const scrollers = [...p.querySelectorAll("[data-scroller]")];
      const cards = scrollers[scrollers.length - 1];
      const holder = [...p.querySelectorAll("svg")].find((s) => /3344cc/i.test(s.outerHTML) && !cards.contains(s));
      const slides = [...p.querySelectorAll("svg")].find((s) => /12ab34/i.test(s.outerHTML));
      return { scrollers: scrollers.length, holderBefore: !!holder && !!(holder.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING), slidesInCards: !!slides && cards.contains(slides) };
    });
    check("the section holding the carousel is drawn under the carousel", order.scrollers === 2 && order.holderBefore, JSON.stringify(order));
    check("the carousel's content is inside the carousel", order.slidesInCards, JSON.stringify(order));
    await page.context().close();
  }

  // ---- 3. Background blur behind a fixed bar ----
  {
    const page = await newPage();
    await open(page);
    const rows = Array.from({ length: 14 }, (_, i) => ({ type: "text", name: `Row ${i}`, text: `List row number ${i} with some long text`, x: 20, y: 80 + i * 50, fontSize: 22, color: "#111111" }));
    const r = await tool(page, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Feed", x: 0, y: 0, width: 390, height: 600, fill: "#FFFFFF", overflow: "vertical",
          children: [
            ...rows,
            { type: "frame", name: "Bar", x: 0, y: 0, width: 390, height: 80, fill: "rgba(255,255,255,0.3)", backgroundBlur: 20, scrollBehavior: "fixed" },
          ],
        },
      ],
    });
    await setStart(page, ids(r).Feed);
    await present(page);
    const bar = await nodeId(page, "Bar");
    const filter = await page.evaluate((b) => getComputedStyle(document.querySelector(`.presenter [data-backdrop="${b}"]`)).backdropFilter, bar);
    check("the fixed bar has a backdrop underlay with blur(10px)", filter === "blur(10px)", filter);
    await scrollTo(page, 40);
    // Blur is live: the text behind the bar is not crisp. Compare it with the same text where nothing blurs it.
    const clip = await page.evaluate(() => {
      const r = document.querySelector(".presenter [data-scroller]").getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: 80 };
    });
    const withBlur = await page.screenshot({ clip });
    await page.evaluate(() => document.querySelectorAll(".presenter [data-backdrop]").forEach((e) => (e.style.display = "none")));
    const without = await page.screenshot({ clip });
    check("the screenshot differs with the underlay hidden (text behind the bar is blurred)", !withBlur.equals(without));
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, "blur-with.png"), withBlur);
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, "blur-without.png"), without);
    await leave(page);
    await page.context().close();
  }

  // ---- 4. Export: HTML next to the player ----
  let htmlDoc = null;
  {
    const page = await newPage();
    await open(page);
    const r = await tool(page, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Home", x: 0, y: 0, width: 390, height: 844, fill: "#FFFFFF", overflow: "vertical",
          children: [
            {
              type: "frame", name: "Section A", x: 0, y: 0, width: 390, height: 600, fill: "#F1F5F9", clip: true,
              children: [{ type: "rectangle", name: "Header", x: 0, y: 300, width: 390, height: 48, fill: "#2563EB", scrollBehavior: "sticky" }],
            },
            { type: "frame", name: "Section B", x: 0, y: 600, width: 390, height: 900, fill: "#E2E8F0" },
          ],
        },
      ],
    });
    const home = ids(r).Home;
    const ex = await tool(page, "export_code", { id: home, format: "html" });
    htmlDoc = ex.code ?? ex.html ?? ex.content ?? JSON.stringify(ex);
    await setStart(page, home);
    await present(page);
    const header = await nodeId(page, "Header");
    const player = {};
    for (const s of [0, 200, 400, 520, 640]) {
      await scrollTo(page, s);
      player[s] = await topIn(page, `.presenter [data-sticky="${header}"]`);
    }
    await leave(page);
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(htmlDoc);
    });
    await new Promise((resolve) => server.listen(EXPORT_PORT, "127.0.0.1", resolve));
    try {
      const p = await newPage({ viewport: { width: 500, height: 900 } });
      await p.goto(`http://127.0.0.1:${EXPORT_PORT}/`);
      await p.waitForTimeout(300);
      const find = () =>
        p.evaluate(() => {
          const all = [...document.querySelectorAll("body *")];
          const sticky = all.find((e) => getComputedStyle(e).position === "sticky");
          const scroller = all.find((e) => /auto|scroll/.test(getComputedStyle(e).overflowY));
          return { found: !!sticky && !!scroller };
        });
      const f = await find();
      check("the exported HTML has a sticky layer in a scroller", f.found, `${htmlDoc.includes("position: sticky")} ${await p.content().then((c) => c.slice(c.indexOf("<body"), c.indexOf("<body") + 600))}`);
      const out = {};
      for (const s of [0, 200, 400, 520, 640]) {
        out[s] = await p.evaluate((t) => {
          const all = [...document.querySelectorAll("body *")];
          const sticky = all.find((e) => getComputedStyle(e).position === "sticky");
          const scroller = all.find((e) => /auto|scroll/.test(getComputedStyle(e).overflowY));
          scroller.scrollTop = t;
          return sticky.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        }, s);
      }
      for (const s of [0, 200, 400, 520, 640]) check(`export header matches the player at scroll ${s} (±1 px)`, Math.abs(out[s] - player[s]) <= 1, `export ${out[s]} player ${player[s]}`);
      await shot(p, "export-sticky");
      await p.context().close();
    } finally {
      server.close();
    }
    await page.context().close();
  }

  // ---- 5. Panel ----
  {
    const page = await newPage();
    await open(page);
    const r = await tool(page, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Home", x: 0, y: 0, width: 390, height: 844, fill: "#FFFFFF", overflow: "vertical",
          children: [{ type: "rectangle", name: "Header", x: 0, y: 100, width: 390, height: 48, fill: "#2563EB" }, { type: "rectangle", name: "Tall", x: 0, y: 300, width: 390, height: 1500, fill: "#E2E8F0" }],
        },
        { type: "frame", name: "Other", x: 600, y: 0, width: 390, height: 844, fill: "#DCFCE7" },
      ],
    });
    const m = ids(r);
    const header = await nodeId(page, "Header");
    await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), header);
    await page.click("#right-tab-prototype");
    await page.waitForTimeout(300);
    await page.selectOption("select[aria-label='Position when scrolling']", "sticky");
    await page.waitForTimeout(200);
    const sb = await page.evaluate((id) => window.__dt.doc().nodes[id].scrollBehavior, header);
    check("Position: Sticky saves to the document", sb === "sticky", sb);
    await tool(page, "update_nodes", { updates: [{ id: m.Home, overflow: "none" }] });
    await page.waitForTimeout(200);
    check("the hint appears when no ancestor scrolls vertically", await page.locator("text=Sticky works inside a frame that scrolls vertically.").isVisible());
    await tool(page, "update_nodes", { updates: [{ id: m.Home, overflow: "vertical" }] });
    await page.waitForTimeout(200);
    check("and goes away when one does", (await page.locator("text=Sticky works inside a frame that scrolls vertically.").count()) === 0);
    // On drag and a custom curve.
    await page.getByRole("button", { name: "Add interaction" }).click();
    await page.waitForTimeout(300);
    await page.selectOption("select[aria-label='Trigger']", "onDrag");
    await page.waitForTimeout(200);
    await page.selectOption("select[aria-label='Destination']", m.Other).catch(() => {});
    await page.selectOption("select[aria-label='Transition']", "dissolve");
    await page.waitForTimeout(200);
    check("On drag with Dissolve shows the follow hint", await page.locator("text=On drag follows the pointer with Smart animate, Move or Push").isVisible());
    await page.selectOption("select[aria-label='Transition']", "smartAnimate");
    await page.waitForTimeout(200);
    check("and not with Smart animate", (await page.locator("text=On drag follows the pointer with Smart animate").count()) === 0);
    await page.selectOption("select[aria-label='Easing']", "custom");
    await page.waitForTimeout(200);
    let it = await page.evaluate((id) => window.__dt.doc().nodes[id].interactions[0], header);
    check("Custom bezier sets 0.42, 0, 0.58, 1 and keeps the preset", it.trigger === "onDrag" && JSON.stringify(it.bezier) === "[0.42,0,0.58,1]" && (it.easing ?? "easeOut") === "easeOut", JSON.stringify(it));
    await page.fill("input[aria-label='Bezier y1']", "0.2");
    await page.keyboard.press("Enter");
    await page.fill("input[aria-label='Bezier x2']", "7");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    it = await page.evaluate((id) => window.__dt.doc().nodes[id].interactions[0], header);
    check("fields edit the curve, x is clamped to 0-1", it.bezier?.[1] === 0.2 && it.bezier?.[2] === 1, JSON.stringify(it.bezier));
    check("a curve preview is drawn", (await page.locator("svg[aria-label='Curve preview'] path[data-bezier-curve]").count()) === 1);
    await shot(page, "panel");
    // It survives a reload.
    await page.waitForTimeout(1200);
    await page.reload();
    await page.waitForSelector(".files, #dt-canvas", { timeout: 20000 });
    if (await page.locator(".files").count()) await page.locator(".files .file-card, .files [data-file]").first().click().catch(() => {});
    await page.waitForSelector("#dt-canvas", { timeout: 20000 });
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => {
      const n = Object.values(window.__dt.doc().nodes).find((x) => x.name === "Header");
      return n && { sb: n.scrollBehavior, it: n.interactions[0] };
    });
    check("Sticky, On drag and the curve survive a reload", after?.sb === "sticky" && after.it?.trigger === "onDrag" && after.it?.bezier?.[1] === 0.2, JSON.stringify(after));
    await page.context().close();
  }

  // ---- 6. MCP over the bridge ----
  {
    const page = await newPage();
    await open(page, BRIDGE);
    await page.waitForFunction(() => document.querySelector("[title*='Claude Code'], .bridge-status, body")?.textContent !== null);
    await page.waitForTimeout(1500);
    const rpc = async (method, params, id = 1) => {
      const r = await fetch(`${BRIDGE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      const t = await r.text();
      const line = t.split("\n").find((l) => l.startsWith("data:")) ?? t;
      return JSON.parse(line.replace(/^data:\s*/, ""));
    };
    await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "w4ab", version: "1" } });
    const call = async (name, args) => {
      const r = await rpc("tools/call", { name, arguments: args }, 2);
      return r.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(r);
    };
    const created = await call("create_nodes", {
      nodes: [
        { type: "frame", name: "Home", x: 0, y: 0, width: 300, height: 500, overflow: "vertical", children: [{ type: "rectangle", name: "Head", width: 300, height: 40, fill: "#2563EB" }, { type: "rectangle", name: "Body", y: 60, width: 300, height: 900, fill: "#E2E8F0" }] },
        { type: "frame", name: "Next", x: 400, y: 0, width: 300, height: 500 },
      ],
    });
    const idOf = (name) => (created.match(new RegExp(`"name":\\s*"${name}"[^}]*?"id":\\s*"([^"]+)"|"id":\\s*"([^"]+)"[^}]*?"name":\\s*"${name}"`)) ?? []).slice(1).find(Boolean);
    const head = idOf("Head") ?? (await nodeId(page, "Head"));
    const next = idOf("Next") ?? (await nodeId(page, "Next"));
    const upd = await call("update_nodes", { updates: [{ id: head, scrollBehavior: "sticky" }] });
    check("update_nodes scrollBehavior sticky: no 'not supported' text", !/not supported/.test(upd), upd);
    const proto = await call("set_prototype", { nodeId: head, trigger: "drag", action: "navigate", destinationId: next, transition: "smart_animate", easing: "custom", bezier: [0.2, 0, 0.4, 1] });
    check("set_prototype trigger drag with a custom bezier", /onDrag/.test(proto), proto);
    const stored = await page.evaluate((id) => {
      const n = window.__dt.doc().nodes[id];
      return { sb: n.scrollBehavior, it: n.interactions[0] };
    }, head);
    check("the editor holds sticky, onDrag and the bezier", stored.sb === "sticky" && stored.it?.trigger === "onDrag" && JSON.stringify(stored.it.bezier) === "[0.2,0,0.4,1]", JSON.stringify(stored));
    const bad = await call("set_prototype", { nodeId: head, trigger: "drag", action: "navigate", destinationId: next, bezier: [2, 0, 0.4, 1] });
    check("an x outside 0-1 is an error", /bezier/.test(bad) && /between 0 and 1/.test(bad), bad);
    const got = await call("get_nodes", { ids: [head] });
    check("get_nodes shows the new values", /sticky/.test(got) && /onDrag/.test(got), got.slice(0, 300));
    await page.context().close();
  }

  // ---- 7. Collab: a raw client without `model` on the relays ----
  const wsDial = (base, roomOrQuery, join) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?${roomOrQuery}`);
      const got = [];
      const waiters = [];
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", name: "raw", color: "#000000", granular: true, lists: true, ...join }));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        got.push(m);
        waiters.splice(0).forEach((w) => w());
      };
      ws.onerror = () => reject(new Error("socket error " + base));
      const client = {
        got,
        send: (m) => ws.send(JSON.stringify(m)),
        wait: async (pred, ms = 4000) => {
          const end = Date.now() + ms;
          for (;;) {
            const hit = got.find(pred);
            if (hit) return hit;
            if (Date.now() > end) return null;
            await new Promise((r) => {
              waiters.push(r);
              setTimeout(r, 100);
            });
          }
        },
        close: () => ws.close(),
      };
      ws.addEventListener("open", () => resolve(client));
    });
  const baseDoc = () => ({
    id: "d1", name: "T", schema: 1, pages: [{ id: "p1", name: "Page 1", children: ["f1"], background: "#F5F5F5", flowStart: null, guides: [] }],
    nodes: {
      f1: {
        id: "f1", type: "frame", name: "Home", page: "p1", parent: null, children: ["r1"], x: 0, y: 0, width: 300, height: 400, overflow: "vertical",
        fills: [{ type: "angularGradient", stops: [{ position: 0, color: "#000000" }, { position: 1, color: "#ffffff" }], opacity: 1, visible: true }],
      },
      r1: {
        id: "r1", type: "rectangle", name: "Head", page: "p1", parent: "f1", children: [], x: 0, y: 0, width: 300, height: 40, scrollBehavior: "sticky",
        interactions: [{ trigger: "onDrag", action: "back" }, { trigger: "onClick", action: "back" }],
      },
    },
  });
  for (const [label, base, model4] of [["new relay", RELAY, true], ["older relay (ead5ada)", RELAY_OLD, false]]) {
    const up = await fetch(`${base}/health`).then((r) => r.ok, () => false);
    if (!up) {
      check(`${label} is up`, false, base);
      continue;
    }
    const room = "w4ab" + Math.random().toString(36).slice(2) + "abcdefghij";
    // The editor at revision 4 is a real page; the downgrade for the old relay is the editor's own.
    const page = await newPage();
    await open(page);
    await tool(page, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Home", x: 0, y: 0, width: 300, height: 400, overflow: "vertical",
          children: [{ type: "rectangle", name: "Head", x: 0, y: 0, width: 300, height: 40, fill: "#2563EB" }],
        },
        { type: "frame", name: "Next", x: 400, y: 0, width: 300, height: 400 },
      ],
    });
    const frame = await nodeId(page, "Home");
    const head = await nodeId(page, "Head");
    const next = await nodeId(page, "Next");
    await tool(page, "update_nodes", { updates: [{ id: frame, fill: { type: "angularGradient", stops: [{ position: 0, color: "#000000" }, { position: 1, color: "#ffffff" }] } }] });
    await page.click(".tbtn[title='Share for live editing']");
    await page.waitForTimeout(300);
    await page.fill(".share-dialog input.textinput >> nth=0", "Olga");
    if (!(await page.locator(".share-dialog input.mono").count())) await page.click("text=Use a different relay").catch(() => {});
    await page.fill(".share-dialog input.mono", base);
    await page.click("button:has-text('Share online')");
    await page.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 15000 }).catch(() => {});
    const live = await page.evaluate(() => window.__dt.collab().status);
    check(`${label}: the editor shares`, live === "live", live);
    const link = await page.evaluate(() => window.__dt.collab().link);
    const roomId = new globalThis.URL(link).searchParams.get("room");
    await page.keyboard.press("Escape");
    // Make the changes a rev-3 relay would reject.
    const toasts = [];
    page.on("console", (m) => /couldn't take/.test(m.text()) && toasts.push(m.text()));
    await tool(page, "update_nodes", { updates: [{ id: head, scrollBehavior: "sticky" }] });
    await tool(page, "set_prototype", { nodeId: head, trigger: "drag", action: "navigate", destinationId: next, transition: "smart_animate" });
    await tool(page, "set_prototype", { nodeId: head, trigger: "click", action: "navigate", destinationId: next, transition: "push" });
    await page.waitForTimeout(1500);
    check(`${label}: no "relay couldn't take your change" toast`, (await page.locator("text=couldn't take your last change").count()) === 0 && toasts.length === 0);
    // A raw editor without `model` (revision 3) and one with model 4.
    const old = await wsDial(base, `room=${roomId}`, {});
    const cur = await wsDial(base, `room=${roomId}`, { model: 4 });
    const wOld = await old.wait((m) => m.type === "welcome");
    const wCur = await cur.wait((m) => m.type === "welcome");
    const nodesOf = (w) => Object.values(w.doc.nodes);
    const hOld = nodesOf(wOld).find((n) => n.name === "Head");
    const hCur = nodesOf(wCur).find((n) => n.name === "Head");
    const gradOf = (w) => nodesOf(w).find((n) => n.name === "Home").fills?.[0]?.type;
    if (model4) {
      check(`${label}: the room keeps On drag and sticky for a model 4 editor`, hCur.scrollBehavior === "sticky" && hCur.interactions.some((i) => i.trigger === "onDrag"), JSON.stringify(hCur.interactions));
      check(`${label}: a join without model gets scroll and no On drag, keeps the click and Push`, (hOld.scrollBehavior ?? "scroll") === "scroll" && !hOld.interactions.some((i) => i.trigger === "onDrag") && hOld.interactions.some((i) => i.trigger === "onClick" && i.transition === "push"), JSON.stringify(hOld));
      check(`${label}: the angular gradient stays for both`, gradOf(wOld) === "angularGradient" && gradOf(wCur) === "angularGradient", `${gradOf(wOld)} ${gradOf(wCur)}`);
      // The next change reaches each as it can read it.
      await tool(page, "update_nodes", { updates: [{ id: head, name: "Head 2" }] });
      await tool(page, "set_prototype", { nodeId: head, trigger: "drag", action: "back" });
      const dOld = await old.wait((m) => m.type === "delta" && JSON.stringify(m.delta).includes("interactions"));
      const dCur = await cur.wait((m) => m.type === "delta" && JSON.stringify(m.delta).includes("interactions"));
      const hasDrag = (d) => JSON.stringify(d.delta).includes('"onDrag"');
      check(`${label}: the next delta is downgraded for the model-less editor only`, !!dOld && !!dCur && !hasDrag(dOld) && hasDrag(dCur), `${dOld && hasDrag(dOld)} ${dCur && hasDrag(dCur)}`);
    } else {
      check(`${label}: the relay stored On drag and sticky downgraded (no onDrag, scroll)`, !hCur.interactions.some((i) => i.trigger === "onDrag") && (hCur.scrollBehavior ?? "scroll") === "scroll", JSON.stringify(hCur));
      check(`${label}: the angular gradient set earlier is still stored`, gradOf(wCur) === "angularGradient", gradOf(wCur));
    }
    old.close();
    cur.close();
    await page.context().close();
  }

  // ---- 7b. LAN room through the bridge: two editors, and a raw client without model ----
  {
    const owner = await newPage();
    const guest = await newPage();
    await open(owner, BRIDGE);
    await tool(owner, "create_nodes", {
      nodes: [
        { type: "frame", name: "Home", x: 0, y: 0, width: 300, height: 400, overflow: "vertical", children: [{ type: "rectangle", name: "Head", width: 300, height: 40, fill: "#2563EB" }] },
        { type: "frame", name: "Next", x: 400, y: 0, width: 300, height: 400 },
      ],
    });
    await owner.click(".tbtn[title='Share for live editing']");
    await owner.fill(".share-dialog input.textinput >> nth=0", "Olga");
    await owner.click("button:has-text('Share on this network')");
    await owner.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 15000 });
    const link = await owner.evaluate(() => window.__dt.collab().link);
    await owner.keyboard.press("Escape");
    // The link points at the LAN listener (port + 1) with the token; open it on the same machine.
    const token = (link.match(/collab=([0-9a-f]+)/) ?? [])[1];
    const lan = new globalThis.URL(link);
    const guestUrl = `http://127.0.0.1:${lan.port}${lan.pathname}${lan.search}`;
    await guest.goto(guestUrl);
    await guest.waitForFunction(() => window.__dt?.collab?.().status === "live", null, { timeout: 20000 }).catch(() => {});
    const gl = await guest.evaluate(() => window.__dt?.collab?.().status);
    check("LAN: a guest editor joins", gl === "live", gl);
    const head = await nodeId(owner, "Head");
    const next = await nodeId(owner, "Next");
    await tool(owner, "update_nodes", { updates: [{ id: head, scrollBehavior: "sticky" }] });
    await tool(owner, "set_prototype", { nodeId: head, trigger: "drag", action: "navigate", destinationId: next, transition: "push" });
    await guest.waitForFunction(() => Object.values(window.__dt.doc().nodes).some((n) => n.name === "Head" && n.scrollBehavior === "sticky" && n.interactions?.some((i) => i.trigger === "onDrag")), null, { timeout: 8000 }).catch(() => {});
    const seen = await guest.evaluate(() => {
      const n = Object.values(window.__dt.doc().nodes).find((x) => x.name === "Head");
      return n && { sb: n.scrollBehavior, drag: n.interactions?.some((i) => i.trigger === "onDrag") };
    });
    check("LAN: two editors see each other's sticky and On drag", seen?.sb === "sticky" && seen?.drag === true, JSON.stringify(seen));
    if (token) {
      const raw = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${lan.port}/collab/ws?token=${token}`);
        const got = [];
        ws.onopen = () => ws.send(JSON.stringify({ type: "join", name: "raw", color: "#000000", granular: true, lists: true }));
        ws.onmessage = (e) => got.push(JSON.parse(e.data));
        ws.onerror = () => resolve(null);
        setTimeout(() => resolve({ got, ws }), 2500);
      });
      const w = raw?.got.find((m) => m.type === "welcome");
      const h = w && Object.values(w.doc.nodes).find((n) => n.name === "Head");
      check("LAN: a raw client without model gets a welcome with neither", !!h && (h.scrollBehavior ?? "scroll") === "scroll" && !h.interactions.some((i) => i.trigger === "onDrag"), h ? JSON.stringify(h) : "no welcome");
      await tool(owner, "update_nodes", { updates: [{ id: head, scrollBehavior: "scroll" }] });
      await tool(owner, "update_nodes", { updates: [{ id: head, scrollBehavior: "sticky" }] });
      await new Promise((r) => setTimeout(r, 800));
      const deltas = raw?.got.filter((m) => m.type === "delta") ?? [];
      check("LAN: its deltas never carry sticky", deltas.length > 0 && !deltas.some((d) => JSON.stringify(d.delta).includes('"sticky"')), `${deltas.length} deltas`);
      raw?.ws.close();
    } else check("LAN: token in the link", false, link);
    await owner.context().close();
    await guest.context().close();
  }

  // ---- 8. Exported project: a swipe runs On drag ----
  const deps = process.env.E2E_DEPS;
  if (!deps) console.log("SKIP  exported project swipe (set E2E_DEPS)");
  else {
    const page = await newPage();
    await open(page);
    const r = await tool(page, "create_nodes", {
      nodes: [
        { type: "frame", name: "Home", x: 0, y: 0, width: 390, height: 600, fill: "#FFFFFF", children: [{ type: "frame", name: "Card", x: 40, y: 100, width: 300, height: 200, fill: "#2563EB", children: [{ type: "text", name: "Card label", text: "Swipe me", x: 20, y: 20, fontSize: 24, color: "#FFFFFF" }] }, { type: "text", name: "Home text", text: "Home screen", x: 20, y: 20, fontSize: 20 }] },
        { type: "frame", name: "Detail", x: 600, y: 0, width: 390, height: 600, fill: "#DCFCE7", children: [{ type: "text", name: "Detail text", text: "Detail screen", x: 20, y: 20, fontSize: 20 }] },
      ],
    });
    const m = ids(r);
    await tool(page, "set_prototype", { nodeId: await nodeId(page, "Card"), trigger: "drag", action: "navigate", destinationId: m.Detail, transition: "push", direction: "left" });
    await setStart(page, m.Home);
    const built = await tool(page, "export_code", { format: "project" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w4ab-project-"));
    for (const f of built.files) {
      fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, f.path), f.content);
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
    check("the exported project passes tsc and vite build", ok, ok ? dir : out.slice(0, 800));
    if (ok) {
      const dist = path.join(dir, "dist");
      const server = http.createServer((req, res) => {
        let f = path.join(dist, decodeURIComponent((req.url ?? "/").split(/[?#]/)[0]));
        if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
        const type = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[path.extname(f)] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": type });
        res.end(fs.readFileSync(f));
      });
      await new Promise((resolve) => server.listen(EXPORT_PORT, "127.0.0.1", resolve));
      try {
        const p = await newPage({ viewport: { width: 500, height: 800 } });
        const base = `http://127.0.0.1:${EXPORT_PORT}/`;
        const seen = (t) => p.getByText(t, { exact: false }).first().isVisible().catch(() => false);
        const swipe = async (dx, dy) => {
          const b = await p.locator("[data-dt-swipe]").first().boundingBox();
          const x = b.x + b.width / 2;
          const y = b.y + b.height / 2;
          await p.mouse.move(x, y);
          await p.mouse.down();
          await p.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
          await p.mouse.move(x + dx, y + dy, { steps: 4 });
          await p.mouse.up();
          await p.waitForTimeout(400);
        };
        await p.goto(base);
        await p.waitForSelector("text=Swipe me");
        await swipe(10, 0);
        check("a 10 px drag does nothing", await seen("Swipe me"));
        await swipe(40, 0);
        check("a 40 px swipe against the direction (right, for Push left) does nothing", await seen("Swipe me"));
        await swipe(-40, 0);
        check("a 40 px swipe left runs On drag", await seen("Detail screen"));
        await p.close();
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    await page.context().close();
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
