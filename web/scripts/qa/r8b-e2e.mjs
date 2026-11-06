// R8-P2: the presenter, prototype and code export. Overlay SVGs keep their own clip paths, While
// pressing plus On click on one layer, Enter after clicking the presenter bar, and an exported
// project whose key triggers, keyboard controls and flow hash work in a real browser.
// Usage: start `npm run dev`, then `E2E_URL=http://localhost:<port> node scripts/qa/r8b-e2e.mjs`.
// Env: E2E_URL (default http://localhost:5173), CHROMIUM (executable path), SHOTS (folder for screenshots),
//      E2E_DEPS (a folder with node_modules for the exported project: `npm install --offline
//      --ignore-scripts` in a folder holding its package.json; without it the export steps are skipped),
//      E2E_STATIC_PORT (static server for the built project, default 5644).

import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const STATIC_PORT = Number(process.env.E2E_STATIC_PORT ?? 5644);
const SHOTS = process.env.SHOTS;
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 400) : ""}`);
}

const browser = await chromium.launch(launch);
const newContext = async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  // Nothing may leave this machine.
  await context.route(
    (u) => !/^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) && !/^(data|blob):/.test(u.toString()),
    (r) => r.abort(),
  );
  await context.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  return context;
};
const errors = [];
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

const tool = (page, name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const ids = (r) => Object.fromEntries(r.result.created.map((c) => [c.name, c.id]));
const newDesign = async (page) => {
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 20000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas", { timeout: 20000 });
  await page.waitForTimeout(300);
};
const setStart = (page, id) =>
  page.evaluate((f) => {
    const d = window.__dt.doc();
    const pg = Object.values(d.pages).find((p) => p.children.includes(f)) ?? Object.values(d.pages)[0];
    window.__dt.dispatch({ op: "setFlowStart", page: pg.id, id: f });
  }, id);
const crumb = (page) => page.locator(".presenter .bar .muted").first().innerText().then((t) => t.trim());
const present = async (page) => {
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter");
  await page.waitForTimeout(400);
};

/** The design as a link payload (the format of #/copy/ and #/view/ links). */
const linkData = (page) =>
  page.evaluate(async () => {
    const json = JSON.stringify({ v: 1, doc: window.__dt.doc(), assets: {} });
    const buf = await new Response(new Blob([new TextEncoder().encode(json)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    let s = "";
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  });

/** Every id on the page is unique, and every url(#id) of the overlay resolves inside the overlay. */
const clipReport = (page) =>
  page.evaluate(() => {
    const all = [...document.querySelectorAll("[id]")].map((e) => e.id);
    const dupes = all.filter((id, i) => all.indexOf(id) !== i);
    const ov = document.querySelector(".overlay-frame");
    const refs = [...(ov?.querySelectorAll("[clip-path],[fill],[mask],[filter]") ?? [])]
      .flatMap((e) => ["clip-path", "fill", "mask", "filter"].map((a) => e.getAttribute(a) ?? ""))
      .map((v) => /url\(#([^)]+)\)/.exec(v)?.[1])
      .filter(Boolean);
    const own = new Set([...(ov?.querySelectorAll("[id]") ?? [])].map((e) => e.id));
    const clipRects = [...(ov?.querySelectorAll("clipPath") ?? [])].map((c) => {
      const r = c.firstElementChild;
      return r ? `${r.getAttribute("width")}x${r.getAttribute("height")}` : "";
    });
    const lines = [...(ov?.querySelectorAll("tspan") ?? [])].map((t) => {
      const b = t.getBoundingClientRect();
      return { text: t.textContent, w: Math.round(b.width), h: Math.round(b.height) };
    });
    return { dupes, unresolved: refs.filter((r) => !own.has(r)), clipRects, lines };
  });

try {
  // ---- Overlay clip paths: a rounded dialog over a screen with a rounded, clipping card ----
  const clipDesign = async (page) => {
    await newDesign(page);
    const r = await tool(page, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Base", x: 0, y: 0, width: 800, height: 600, fill: "#F1F5F9",
          children: [
            { type: "frame", name: "Card", x: 40, y: 40, width: 300, height: 40, fill: "#FFFFFF", cornerRadius: 16, clip: true, children: [{ type: "text", text: "Open dialog", x: 20, y: 8, fontSize: 18 }] },
          ],
        },
        {
          type: "frame", name: "Dialog", x: 1000, y: 0, width: 360, height: 200, fill: "#FFFFFF", cornerRadius: 16, clip: true,
          children: [
            { type: "text", text: "Line one", x: 24, y: 24, fontSize: 18 },
            { type: "text", text: "Line two", x: 24, y: 70, fontSize: 18 },
            { type: "text", text: "Line three", x: 24, y: 116, fontSize: 18 },
          ],
        },
      ],
    });
    const m = ids(r);
    const card = await page.evaluate(() => Object.values(window.__dt.doc().nodes).find((n) => n.name === "Card").id);
    await tool(page, "set_prototype", { nodeId: card, action: "open_overlay", destinationId: m.Dialog, overlay: { position: "center", background: "#000000", backgroundOpacity: 0.3 } });
    await setStart(page, m.Base);
    return card;
  };
  const checkOverlay = async (page, card, where) => {
    await page.locator(`.presenter [data-hotspot="${card}"]`).click();
    await page.waitForSelector(".overlay-frame");
    await page.waitForTimeout(500);
    const rep = await clipReport(page);
    check(`${where}: no id appears twice on the page`, rep.dupes.length === 0, rep.dupes.join(","));
    check(`${where}: the overlay's references resolve inside the overlay`, rep.unresolved.length === 0, rep.unresolved.join(","));
    check(`${where}: the overlay clips to its own 360x200 frame`, rep.clipRects.includes("360x200"), rep.clipRects.join(","));
    check(`${where}: all three lines are laid out`, rep.lines.length === 3 && rep.lines.every((l) => l.w > 0 && l.h > 0), JSON.stringify(rep.lines));
    await shot(page, `clip-${where.replace(/\W+/g, "-")}`);
  };
  {
    const context = await newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    const card = await clipDesign(page);
    const data = await linkData(page);
    await present(page);
    await checkOverlay(page, card, "Present");
    await page.goto(`${URL}/#/view/${data}`);
    await page.waitForSelector(".presenter", { timeout: 20000 });
    await page.waitForTimeout(500);
    await checkOverlay(page, card, "view link");
    await context.close();
  }

  // ---- While pressing + On click on one layer; Enter after clicking Back ----
  {
    const context = await newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    await newDesign(page);
    const r = await tool(page, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Start", x: 0, y: 0, width: 600, height: 400, fill: "#F1F5F9",
          children: [
            { type: "frame", name: "Tap", x: 40, y: 100, width: 200, height: 60, fill: "#2563EB", children: [{ type: "text", text: "Tap me", x: 20, y: 18, fontSize: 18, color: "#FFFFFF" }] },
          ],
        },
        { type: "frame", name: "Pressed", x: 700, y: 0, width: 600, height: 400, fill: "#FDE68A", children: [{ type: "text", text: "Pressed state", x: 40, y: 40, fontSize: 24 }] },
        { type: "frame", name: "Target", x: 1400, y: 0, width: 600, height: 400, fill: "#BBF7D0", children: [{ type: "text", text: "Target screen", x: 40, y: 40, fontSize: 24 }] },
        { type: "frame", name: "Keyed", x: 2100, y: 0, width: 600, height: 400, fill: "#DDD6FE", children: [{ type: "text", text: "Keyed screen", x: 40, y: 40, fontSize: 24 }] },
      ],
    });
    const m = ids(r);
    const tap = await page.evaluate(() => Object.values(window.__dt.doc().nodes).find((n) => n.name === "Tap").id);
    await tool(page, "set_prototype", { nodeId: tap, action: "navigate", destinationId: m.Pressed, trigger: "press" });
    await tool(page, "set_prototype", { nodeId: tap, action: "navigate", destinationId: m.Target });
    await tool(page, "set_prototype", { nodeId: m.Start, action: "navigate", destinationId: m.Keyed, trigger: "key", key: "Enter" });
    await setStart(page, m.Start);
    await present(page);
    const spot = page.locator(`.presenter [data-hotspot="${tap}"]`);
    const box = await spot.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(250);
    check("press shows the Pressed screen while the pointer is down", (await crumb(page)).includes("Pressed"), await crumb(page));
    await shot(page, "press-down");
    await page.mouse.up();
    await page.waitForTimeout(700);
    check("the release runs the click: Target", (await crumb(page)).includes("Target"), await crumb(page));
    await shot(page, "press-released");

    await page.locator(".presenter .bar button[title=Back]").click();
    await page.waitForTimeout(500);
    check("Back returns to Start", (await crumb(page)).includes("Start"), await crumb(page));
    // Pressing and dragging off the layer is not a tap: the press is put back and nothing navigates.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(250);
    await page.mouse.move(cx + 300, cy + 150, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    check("a press released away from the layer only puts the screen back", (await crumb(page)).includes("Start"), await crumb(page));

    // The Back button still has focus from the click above; Enter belongs to the design.
    await page.locator(".presenter .bar button[title=Back]").click();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    check("Enter after clicking Back runs the key trigger", (await crumb(page)).includes("Keyed"), await crumb(page));
    await shot(page, "enter-after-back");
    await context.close();
  }

  // ---- An exported project ----
  const deps = process.env.E2E_DEPS;
  if (!deps) {
    console.log("SKIP  exported project steps (set E2E_DEPS)");
  } else {
    const context = await newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    await newDesign(page);
    const r = await tool(page, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Login", x: 0, y: 0, width: 500, height: 520, fill: "#FFFFFF", layout: { direction: "vertical", gap: 16, padding: 24 },
          children: [
            { type: "text", text: "Welcome back", fontSize: 28 },
            { type: "frame", name: "Continue", width: 160, height: 44, fill: "#2563EB", children: [{ type: "text", name: "Continue label", text: "Continue", x: 40, y: 12, fontSize: 16, color: "#FFFFFF" }] },
            { type: "frame", name: "Row", width: "fill", height: 50, fill: "#E2E8F0", children: [{ type: "rectangle", name: "Dot", x: 10, y: 15, width: 20, height: 20, fill: "#475569" }] },
            { type: "frame", name: "Plan card", width: "fill", height: 150, fill: "#F1F5F9", cornerRadius: 12, layout: { direction: "vertical", gap: 8, padding: 16 }, children: [{ type: "text", text: "Pro plan", fontSize: 20 }, { type: "text", text: "Everything included", fontSize: 14 }] },
          ],
        },
        { type: "frame", name: "Dashboard", x: 600, y: 0, width: 500, height: 520, fill: "#DCFCE7", children: [{ type: "text", text: "Dashboard screen", x: 24, y: 24, fontSize: 24 }] },
        { type: "frame", name: "Settings", x: 1200, y: 0, width: 500, height: 520, fill: "#FEF3C7", children: [{ type: "text", text: "Settings screen", x: 24, y: 24, fontSize: 24 }] },
      ],
    });
    const m = ids(r);
    const node = (name) => page.evaluate((n) => Object.values(window.__dt.doc().nodes).find((x) => x.name === n).id, name);
    await tool(page, "set_prototype", { nodeId: await node("Continue"), action: "navigate", destinationId: m.Dashboard });
    await tool(page, "set_prototype", { nodeId: await node("Row"), action: "navigate", destinationId: m.Settings });
    await tool(page, "set_prototype", { nodeId: await node("Plan card"), action: "navigate", destinationId: m.Dashboard });
    await tool(page, "set_prototype", { nodeId: m.Login, action: "navigate", destinationId: m.Dashboard, trigger: "key", key: "Enter" });
    await setStart(page, m.Login);
    await tool(page, "pages", { action: "add", name: "Mobile" });
    const mobilePage = await page.evaluate(() => Object.values(window.__dt.doc().pages).find((p) => p.name === "Mobile").id);
    await tool(page, "pages", { action: "switch", id: mobilePage });
    const mr = await tool(page, "create_nodes", {
      nodes: [{ type: "frame", name: "M Onboarding", x: 0, y: 0, width: 390, height: 800, fill: "#FFFFFF", children: [{ type: "text", text: "Mobile onboarding", x: 24, y: 24, fontSize: 24 }] }],
    });
    await setStart(page, ids(mr)["M Onboarding"]);

    const built = await page.evaluate(async () => {
      const ex = await import("/src/exporter.ts");
      return ex.projectFiles();
    });
    const get = (p) => built.files.find((f) => f.path === p)?.content ?? "";
    const app = get("src/App.tsx");
    const login = get("src/screens/Login.tsx");
    check("the Enter key trigger is a keys entry, not a click on the root", /"Login":\[\{"key":"Enter","to":"Dashboard"\}\]/.test(app) && !/^\s*<div className="relative[^\n]*onClick/m.test(login), app.match(/const keys[^\n]*/)?.[0]);
    check("the README lists both flows", /`\/#Login`/.test(get("README.md")) && /`\/#MOnboarding`/.test(get("README.md")), get("README.md").slice(-700));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r8b-project-"));
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
      await new Promise((resolve) => server.listen(STATIC_PORT, "127.0.0.1", resolve));
      try {
        const p = await context.newPage();
        p.on("pageerror", (e) => errors.push(String(e)));
        const base = `http://127.0.0.1:${STATIC_PORT}/`;
        const seen = (t) => p.getByText(t, { exact: false }).first().isVisible().catch(() => false);
        await p.goto(base);
        await p.waitForSelector("text=Welcome back");
        await shot(p, "export-login");
        // The empty part of the screen does nothing; only controls and keys navigate.
        const wrap = await p.locator("text=Welcome back").boundingBox();
        await p.mouse.click(wrap.x + 300, 480 + 20);
        await p.waitForTimeout(300);
        check("clicking empty space on Login stays on Login", await seen("Welcome back"));
        await p.keyboard.press("Enter");
        await p.waitForTimeout(400);
        check("Enter on Login goes to the Dashboard", await seen("Dashboard screen"));

        await p.goto(base + "?again");
        await p.waitForSelector("text=Welcome back");
        const stops = [];
        for (let i = 0; i < 4; i++) {
          await p.keyboard.press("Tab");
          stops.push(await p.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.getAttribute("role") ?? ""}:${(document.activeElement?.textContent ?? "").trim().slice(0, 12)}`));
        }
        check("Tab reaches the button, the row and the card", stops.some((s) => s.startsWith("BUTTON:")) && stops.filter((s) => s.includes(":button:")).length >= 2 && stops.some((s) => s.includes("Pro plan")), stops.join(" | "));
        await shot(p, "export-tab-focus");
        // Focus is on the card (last of the stops): Enter runs its action.
        await p.keyboard.press("Enter");
        await p.waitForTimeout(400);
        check("Enter on the focused card navigates", await seen("Dashboard screen"));

        await p.goto(base + "#MOnboarding");
        await p.waitForSelector("text=Mobile onboarding");
        check("/#MOnboarding opens the mobile flow", await seen("Mobile onboarding"));
        await shot(p, "export-mobile-flow");
        await p.close();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    await context.close();
  }

  check("no page errors", errors.length === 0, errors.join("; "));
} catch (err) {
  failed++;
  console.log("FAIL  script error  — " + (err.stack ?? err));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
