// HTML import fidelity: inline formatting stays one text layer with mixed runs, imported blocks
// land within 2 px of the browser's, URL imports are named after the page's <title>, the result
// exports to semantic code, and bad inputs fail loudly.
// Usage: E2E_URL=http://localhost:5321 E2E_BRIDGE=http://127.0.0.1:5322 [E2E_STATIC_PORT=5324] \
//          node scripts/qa/w7c-e2e.mjs
// E2E_URL is a dev server (or the bridge) that proxies /bridge/* to E2E_BRIDGE; the URL import
// checks need it. The fixtures in scripts/fixtures/import are served on E2E_STATIC_PORT.
// Nothing leaves the machine: every non-local request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const URL_ = process.env.E2E_URL ?? "http://localhost:5321";
const STATIC_PORT = Number(process.env.E2E_STATIC_PORT ?? 5324);
// Text layers with no block of the same text in the browser (input boxes and the like), per fixture.
const ALLOW_UNMATCHED = { "flex.html": 2 }; // two display:inline spans ("Last 30 days", "Today") that are no block of their own
const OUT = process.env.E2E_OUT ?? "/tmp/w7c-shots";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/import");
fs.mkdirSync(OUT, { recursive: true });

const launch = { headless: true, args: ["--no-sandbox"] };
launch.executablePath = process.env.CHROMIUM ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
if (!launch.executablePath) delete launch.executablePath;

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const server = http.createServer((req, res) => {
  const file = path.join(FIXTURES, path.basename(new globalThis.URL(req.url, "http://x").pathname));
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(STATIC_PORT, "127.0.0.1", r));

const browser = await chromium.launch(launch);
const isLocal = (u) => u.startsWith("data:") || u.startsWith("blob:") || /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u);

async function openEditor() {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await context.route("**/*", (route) => (isLocal(route.request().url()) ? route.continue() : route.abort()));
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
  await page.goto(URL_);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  return { page, context, errors };
}

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const doc = (p) => p.evaluate(() => window.__dt.doc());
const tool = (p, name, input) => p.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const importHtml = async (p, name, width, extra = {}) => {
  const r = await tool(p, "import_html", { html: fixture(name), width, x: 0, y: 0, ...extra });
  const id = r.result?.created?.[0]?.id;
  return { r, id, d: id ? await doc(p) : null };
};

/** Absolute position of a layer relative to the imported root. */
function absOf(d, id, root) {
  const pos = (nid) => {
    let x = 0;
    let y = 0;
    for (let cur = d.nodes[nid]; cur; cur = cur.parent ? d.nodes[cur.parent] : null) {
      x += cur.x;
      y += cur.y;
    }
    return { x, y };
  };
  const a = pos(id);
  const o = pos(root);
  return { x: a.x - o.x, y: a.y - o.y };
}
const subtree = (d, id) => [d.nodes[id], ...(d.nodes[id].children ?? []).flatMap((c) => subtree(d, c))];
const textLayers = (d, root) => subtree(d, root).filter((n) => n.text && n.text.characters.trim());
const norm = (s) => s.toLowerCase().replace(/\s+/g, "");

/** The browser's text blocks: the content box of the deepest non-inline element whose text equals a layer's. */
const BLOCKS = `(() => {
  const out = [];
  for (const el of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "inline" || cs.display === "none") continue;
    const text = el.textContent.replace(/\\s+/g, " ").trim();
    if (!text) continue;
    const r = el.getBoundingClientRect();
    const pl = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const pt = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
    const pb = parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
    const pr = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
    out.push({ text, w: r.width - pl - pr, depth: (() => { let d = 0; for (let e = el; e; e = e.parentElement) d++; return d; })(), x: r.left + pl, y: r.top + scrollY + pt, h: r.height - pt - pb, align: cs.textAlign });
  }
  return out;
})()`;

async function reference(name, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${STATIC_PORT}/${name}`);
  await p.waitForTimeout(250);
  const blocks = await p.evaluate(BLOCKS);
  await ctx.close();
  return blocks;
}

/** Compares every text layer with the browser's block that holds the same text. A block that is
 *  taller (an input box, a centred flex item) or wider than its text only says where the box is,
 *  not where the text goes, so those are skipped for that axis. Layers with no block of the same
 *  text are reported, not skipped. */
async function fidelity(name, width, d, root) {
  const blocks = await reference(name, width);
  let matched = 0;
  const bad = [];
  const unmatched = [];
  for (const n of textLayers(d, root)) {
    const want = norm(n.text.characters);
    const b = blocks.filter((q) => norm(q.text) === want).sort((p, q) => q.depth - p.depth)[0];
    if (!b) {
      unmatched.push(n.text.characters.slice(0, 24));
      continue;
    }
    matched++;
    const at = absOf(d, n.id, root);
    const fits = Math.abs(n.height - b.h) <= 2;
    const dx = ["left", "start"].includes(b.align) && Math.abs(n.width - b.w) <= 2 ? at.x - b.x : 0;
    const dy = fits ? at.y - b.y : 0;
    const dh = fits ? 0 : n.height > b.h + 2 ? n.height - b.h : 0;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2 || dh > 2) bad.push(`${n.text.characters.slice(0, 24)} dx=${dx.toFixed(1)} dy=${dy.toFixed(1)} dh=${dh.toFixed(1)}`);
  }
  return { matched, bad, unmatched };
}

/** Pairs of sibling text layers that overlap by more than 2 px in both directions. */
function overlaps(d, root) {
  const out = [];
  for (const f of subtree(d, root)) {
    const kids = (f.children ?? []).map((c) => d.nodes[c]).filter((n) => n.text && n.text.characters.trim());
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i];
        const b = kids[j];
        const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (ox > 2 && oy > 2) out.push(`${a.text.characters.slice(0, 16)} x ${b.text.characters.slice(0, 16)}`);
      }
    }
  }
  return out;
}

try {
  const { page, context, errors } = await openEditor();

  // 1. A paragraph with inline formatting is one text layer with several runs and a link.
  const inline = await importHtml(page, "inline.html", 400, { name: "Inline" });
  check("inline.html imports", !!inline.id, inline.id ? "" : JSON.stringify(inline.r).slice(0, 200));
  const texts = textLayers(inline.d, inline.id);
  const rich = texts.filter((n) => n.text.characters.startsWith("Use "));
  check("rich paragraph is exactly one text layer", rich.length === 1 && rich[0].text.characters.includes("gap: 16px") && rich[0].text.characters.includes("a link"), `${rich.length} layer(s)`);
  const runs = rich[0]?.text.runs ?? [];
  check("it has at least 3 runs and a link run", runs.length >= 3 && runs.some((r) => r.link?.startsWith("https://x.dev")), `${runs.length} runs`);
  check("bold, italic and code runs carry their styles", runs.some((r) => r.fontWeight >= 700) && runs.some((r) => r.italic) && runs.some((r) => /mono/i.test(r.fontFamily ?? "")));
  check("text layers: heading with em is one layer", texts.some((n) => n.text.characters === "Writing for humans"));
  const brs = texts.find((n) => n.text.characters.startsWith("First line"));
  check("<br> becomes a line break in one layer", brs?.text.characters === "First line\nSecond line bold\nThird line", JSON.stringify(brs?.text.characters));
  check("superscript paragraph falls back without dropping text", texts.some((n) => n.text.characters.includes("superscript")) || texts.some((n) => n.text.characters === "1"));
  const refBlocks = await reference("inline.html", 400);
  const richRef = refBlocks.filter((b) => b.text.startsWith("Use bold")).sort((p, q) => q.depth - p.depth)[0];
  const richAt = rich[0] ? absOf(inline.d, rich[0].id, inline.id) : { x: 0, y: 0 };
  check(
    "its height and position match the browser's paragraph within 2 px",
    !!richRef && !!rich[0] && Math.abs(rich[0].height - richRef.h) <= 2 && Math.abs(richAt.y - richRef.y) <= 2 && Math.abs(richAt.x - richRef.x) <= 2,
    `layer ${rich[0]?.height.toFixed(1)} px tall at y ${richAt.y.toFixed(1)}, browser ${richRef?.h.toFixed(1)} at ${richRef?.y.toFixed(1)}`,
  );
  const fid = await fidelity("inline.html", 400, inline.d, inline.id);
  check("inline.html text layers land within 2 px of the browser's blocks", fid.matched >= 4 && !fid.bad.length && fid.unmatched.length <= 3, `${fid.matched} matched; ${fid.bad.join(" | ")}; unmatched: ${fid.unmatched.join(" | ")}`);
  check("inline.html has no overlapping sibling text layers", !overlaps(inline.d, inline.id).length, overlaps(inline.d, inline.id).join(" | "));
  const flowing = texts.filter((n) => !n.absolutePosition).length;
  check("paragraphs sit in an auto layout flow, none absolute", flowing === texts.length && inline.d.nodes[inline.id].layout?.direction === "vertical", `${flowing}/${texts.length} in flow, root ${inline.d.nodes[inline.id].layout?.direction}`);
  await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), inline.id);
  await page.evaluate(() => window.__dt.zoomToFit());
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/inline.png` });

  // 2. A code chip (background, padding, radius on an inline element) joins the paragraph as a run.
  const badge = await importHtml(page, "badge.html", 420, { name: "Badge", y: 1200 });
  const bt = badge.id ? textLayers(badge.d, badge.id) : [];
  check("badge paragraph is one text layer with the chip as a run", bt.length === 1 && bt[0].text.characters === "Run npm install first, then start the server." && bt[0].text.runs.length >= 3, bt.map((n) => n.text.characters).join(" | "));
  check("badge paragraph has no overlapping layers", !!badge.id && !overlaps(badge.d, badge.id).length);

  // 2b. An inline-block chip keeps its own box (the per-run fallback, whose wrapped runs can still overlap), and blank <br> lines count.
  const chip = await importHtml(page, "chip.html", 420, { name: "Chip", y: 1700 });
  const ct = chip.id ? textLayers(chip.d, chip.id) : [];
  const chipFrame = chip.id && subtree(chip.d, chip.id).some((n) => n.type === "frame" && /4F46E5/i.test(JSON.stringify(n.fills ?? [])));
  check("inline-block chip stays its own layer", !!chipFrame && ct.some((n) => n.text.characters === "Buy now") && ct.some((n) => n.text.characters.startsWith("Click")), ct.map((n) => n.text.characters).join(" | "));
  const blank = ct.find((n) => n.text.characters.startsWith("One"));
  const blankRef = (await reference("chip.html", 420)).filter((q) => q.text.startsWith("One")).sort((p, q) => q.depth - p.depth)[0];
  check("blank <br> lines are counted", blank?.text.characters === "One\n\n\nFour" && !!blankRef && Math.abs(blank.height - blankRef.h) <= 2, `layer ${blank?.height} px, browser ${blankRef?.h}`);

  // 2c. Right-to-left, bidirectional text and bad links.
  const rtl = await importHtml(page, "rtl.html", 420, { name: "RTL", y: 2100 });
  const rtlRef = (await reference("rtl.html", 420)).filter((q) => q.text.startsWith("שלום")).sort((p, q) => q.depth - p.depth)[0];
  const rtlText = rtl.id ? textLayers(rtl.d, rtl.id).find((n) => n.text.characters.startsWith("שלום")) : null;
  check("right-to-left paragraph keeps its lines and height", !!rtlText && !!rtlRef && Math.abs(rtlText.height - rtlRef.h) <= 2 && rtlText.text.lineHeight >= 12, `layer ${rtlText?.height} lh ${rtlText?.text.lineHeight}, browser ${rtlRef?.h}`);
  check("right-to-left paragraph is right aligned", rtlText?.text.alignH === "right", String(rtlText?.text.alignH));
  const bidi = await importHtml(page, "bidi.html", 420, { name: "Bidi", y: 2600 });
  const bidiRef = (await reference("bidi.html", 420)).filter((q) => q.text.startsWith("Meet")).sort((p, q) => q.depth - p.depth)[0];
  const bidiText = bidi.id ? textLayers(bidi.d, bidi.id).find((n) => n.text.characters.startsWith("Meet")) : null;
  check("bidirectional paragraph is one line of normal height", !!bidiText && !!bidiRef && Math.abs(bidiText.height - bidiRef.h) <= 2 && bidiText.text.lineHeight >= 12, `layer ${bidiText?.height} lh ${bidiText?.text.lineHeight}, browser ${bidiRef?.h}`);
  const badlink = await importHtml(page, "badlink.html", 420, { name: "Bad links", y: 3000 });
  const badRuns = badlink.id ? textLayers(badlink.d, badlink.id).flatMap((n) => n.text.runs ?? []) : [];
  check("malformed and script links are dropped, the import still works", !!badlink.id && !badRuns.some((r) => r.link), badlink.id ? "" : JSON.stringify(badlink.r).slice(0, 200));

  // 2d. Edited merged text grows (it stays auto height) and the next layer moves down.
  const edit = inline.d.nodes[rich[0].id];
  check("merged text stays auto height", edit.text.autoResize === "height", String(edit.text.autoResize));
  const longer = rich[0].text.characters + " And now the user adds a whole extra sentence, which needs at least two more lines.";
  await page.evaluate(([id, t]) => window.__dt.dispatch({ op: "update", ids: [id], patch: { text: { characters: t } } }), [rich[0].id, longer]);
  const after = await doc(page);
  const parentKids = after.nodes[after.nodes[rich[0].id].parent].children.map((c) => after.nodes[c]);
  const next = parentKids[parentKids.findIndex((n) => n.id === rich[0].id) + 1];
  const grown = after.nodes[rich[0].id];
  check("editing it grows the layer and pushes the next one down", grown.height > rich[0].height + 20 && next.y >= grown.y + grown.height - 1, `height ${rich[0].height} -> ${grown.height}; next y ${next.y}, bottom ${grown.y + grown.height}`);

  // 3. The existing fixtures still land within 2 px.
  const cases = [["flex.html", 1280], ["grid.html", 1000], ["cards.html", 800], ["form.html", 480], ["typography.html", 800]];
  let y = 2400;
  for (const [name, width] of cases) {
    const imp = await importHtml(page, name, width, { name, y });
    y += 1500;
    if (!imp.id) {
      check(`${name} imports`, false, JSON.stringify(imp.r).slice(0, 200));
      continue;
    }
    const f = await fidelity(name, width, imp.d, imp.id);
    check(`${name} text within 2 px`, f.matched > 0 && !f.bad.length && f.unmatched.length <= (ALLOW_UNMATCHED[name] ?? 0), `${f.matched} matched; ${f.bad.slice(0, 4).join(" | ")}; unmatched: ${f.unmatched.join(" | ")}`);
    check(`${name} has no overlapping sibling text layers`, !overlaps(imp.d, imp.id).length, overlaps(imp.d, imp.id).slice(0, 3).join(" | "));
    if (name === "typography.html") {
      const para = textLayers(imp.d, imp.id).filter((n) => n.text.characters.includes("Code like"));
      check("typography.html paragraph with the .mono chip is one text layer", para.length === 1 && para[0].text.characters.startsWith("Use one accent") && para[0].text.characters.includes("gap: 16px"), `${para.length} layer(s)`);
    }
  }

  // 3b. Whole-pixel rounding must not turn hugging items into fixed fractional heights.
  const round = await importHtml(page, "round.html", 500, { name: "Round", y: y + 100 });
  const roundCode = round.id ? (await tool(page, "export_code", { id: round.id, format: "react" })).result?.code ?? "" : "";
  const fixedFraction = roundCode.match(/\bh-\[\d+\.\d+px\]/g) ?? [];
  const items = round.id ? subtree(round.d, round.id).filter((n) => n.name === "item") : [];
  const rootH = round.id ? round.d.nodes[round.id].height : 0;
  check("round.html list items keep hugging (no fixed fractional heights)", items.length === 14 && !fixedFraction.length && Math.abs(rootH - 705.2) <= 2, `${items.length} items, fixed: ${fixedFraction.slice(0, 3).join(",")}, root ${rootH}`);

  // 3c. Names: a long <title> is cut, and a class only names a layer when it fits the tag.
  const names = await importHtml(page, "names.html", 480, { y: y + 1700 });
  const nameList = names.id ? subtree(names.d, names.id).map((n) => n.name) : [];
  check("a long <title> names the frame with at most 60 characters", !!names.id && names.d.nodes[names.id].name.length <= 60 && names.d.nodes[names.id].name.startsWith("This page title"), String(names.id && names.d.nodes[names.id].name.length));
  check('<button class="menu-toggle"> is a "Button", not named after its class', nameList.includes("Button") && !nameList.some((n) => /menu-toggle|nav-link/.test(n)), nameList.join(", "));
  const namesCode = names.id ? (await tool(page, "export_code", { id: names.id, format: "react" })).result?.code ?? "" : "";
  check("export has a <button> and no <nav> for them", /<button[\s>]/.test(namesCode) && !/<nav[\s>]/.test(namesCode));

  // 4. Names and code export of an imported page, through the typed (File > Import) path.
  const importViaDialog = async (file) => {
    await page.click("button[title='Main menu']");
    await page.click(".menu .item:has-text('Import website or HTML')");
    await page.fill("input[placeholder='https://example.com']", `http://127.0.0.1:${STATIC_PORT}/${file}`);
    await page.click("button:has-text('Import as layers')");
    const done = await page.waitForSelector(".modal:has-text('Import website or HTML'), .toast", { state: "detached", timeout: 20000 }).then(() => true).catch(() => false);
    const err = await page.locator(".error-box").first().innerText({ timeout: 500 }).catch(() => "");
    if (err) await page.click(".modal button:has-text('Cancel')");
    await page.waitForTimeout(400);
    return { done, err };
  };
  if (!process.env.E2E_BRIDGE) {
    console.log("SKIP  URL import checks (set E2E_BRIDGE and run the editor against it)");
  } else {
    const before = new Set(Object.keys((await doc(page)).nodes));
    const via = await importViaDialog("site.html");
    check("Import website of a local page succeeds", !via.err, via.err);
    const d = await doc(page);
    const fresh = Object.values(d.nodes).filter((n) => !before.has(n.id) && !n.parent);
    const frame = fresh[0];
    check("URL import frame is named from <title>", frame?.name === "Acme", `name ${JSON.stringify(frame?.name)}`);
    check("URL import keeps the 1440 px viewport width", frame && Math.round(frame.width) === 1440, `width ${frame?.width}`);
    const absText = frame ? textLayers(d, frame.id).filter((n) => n.absolutePosition).length : -1;
    const stacks = frame ? subtree(d, frame.id).filter((n) => n.layout).length : 0;
    check("no text layer of the imported page is absolutely positioned", absText === 0 && stacks >= 3, `${absText} absolute, ${stacks} auto layout frames`);
    const names = frame ? subtree(d, frame.id).map((n) => n.name) : [];
    check("layers are named for their tags", ["Nav", "Button"].every((n) => names.includes(n)), names.filter((n) => /^(Nav|Button|Link|Header|Footer|Main|Section)/.test(n)).join(", "));
    const code = frame ? (await tool(page, "export_code", { id: frame.id, format: "react" })).result?.code ?? "" : "";
    await fs.promises.writeFile(`${OUT}/site.tsx`, code);
    check("React export uses <nav> and <button>", /<nav[\s>]/.test(code) && /<button[\s>]/.test(code));
    check("React export links are <a> elements, not plain <p>", /<a href="https:\/\/acme\.test\/docs"/.test(code) && !/>\{"Docs"\}<\/p>/.test(code));
    check("React export has an <h1>", /<h1[\s>]/.test(code));
    check("React export has no sub-pixel padding", !/\b(?:p[trblxy]?|gap)-\[\d+\.\d{2,}px\]/.test(code), (code.match(/\b(?:p[trblxy]?|gap)-\[\d+\.\d{2,}px\]/g) ?? []).join(" "));

    const before2 = new Set(Object.keys(d.nodes));
    const via2 = await importViaDialog("flex.html");
    check("page without a <title> is named after the host", !via2.err, via2.err);
    const d2 = await doc(page);
    const frame2 = Object.values(d2.nodes).find((n) => !before2.has(n.id) && !n.parent);
    check("host name names an untitled page", frame2?.name === "127.0.0.1", `name ${JSON.stringify(frame2?.name)}`);
    await page.screenshot({ path: `${OUT}/url-import.png` });
  }

  // 5. Bad inputs.
  const shot = await tool(page, "get_screenshot", { id: "n_missing" });
  check("get_screenshot with an unknown id fails", shot.ok === false && /no layer n_missing/.test(String(shot.result)), String(shot.result).slice(0, 80));
  const shotDefault = await tool(page, "get_screenshot", {});
  check("get_screenshot without an id still picks a frame", shotDefault.ok === true);
  const num = await tool(page, "import_html", { html: 42 });
  check("import_html with a non-string html fails clearly", num.ok === false && /html must be a string/.test(String(num.result)), String(num.result).slice(0, 80));
  const bad = await tool(page, "import_url", { url: "not a url" });
  check("import_url with an invalid URL fails before fetching", bad.ok === false && /not a valid URL/.test(String(bad.result)), String(bad.result).slice(0, 80));
  const bad2 = await tool(page, "import_url", { url: 42 });
  check("import_url with a non-string url fails", bad2.ok === false && /url must be a string/.test(String(bad2.result)), String(bad2.result).slice(0, 80));
  const scheme = await tool(page, "import_url", { url: "ftp://example.com/x" });
  check("import_url with another scheme fails", scheme.ok === false && /http/.test(String(scheme.result)), String(scheme.result).slice(0, 80));

  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  await context.close();
} catch (e) {
  check("script ran to the end", false, String(e?.stack ?? e));
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
