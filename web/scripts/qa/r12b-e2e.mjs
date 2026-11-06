// Round 12, r12b: text panel values and units, group child position.
//  - O2/O3: while editing, the Text section shows the selected characters' weight/size (Regular/Bold/32)
//    and B removes bold from a bold range.
//  - O4/O9/O10: "150%" -> 1.5 x size, "10%" letter spacing, an empty line height is Auto, "1.5" is a
//    multiple in the panel, the text style editor and Claude's tools (same rule).
//  - Papercut: auto-width text in auto layout shows W Hug; Fixed switches the resize mode.
//  - V-2: a group child's X/Y are measured from its frame; typing 0 puts it at the frame edge.
// Usage: dev server (or the bridge serving web/dist), then
//   cd web && E2E_URL=http://127.0.0.1:6121 node scripts/qa/r12b-e2e.mjs        Screenshots: E2E_OUT.
// Every non-local request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL_ = process.env.E2E_URL ?? "http://127.0.0.1:6121";
const OUT = process.env.E2E_OUT ?? "/tmp/r12b-shots";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (u) => ["localhost", "127.0.0.1"].includes(new URL(u).hostname);

const browser = await chromium.launch(launch);
const errors = [];

async function fresh() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  await context.route("**/*", (route) => {
    const u = route.request().url();
    return local(u) || u.startsWith("data:") || u.startsWith("blob:") ? route.continue() : route.abort();
  });
  const p = await context.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(URL_, { waitUntil: "domcontentloaded" });
  await p.getByText("New design file").first().click();
  await p.waitForSelector("#dt-canvas", { timeout: 20000 });
  await sleep(600);
  return p;
}
const tool = (p, name, input) => p.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const doc = (p) => p.evaluate(() => window.__dt.doc());
const named = async (p, name) => Object.values((await doc(p)).nodes).find((n) => n.name === name);
const select = (p, ids) => p.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), ids);
const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
const field = (p, title) => p.locator(`label.field[title="${title}"] input`).first();
const fieldByAria = (p, aria) => p.locator(`[aria-label="${aria}"]`).first();
async function type(loc, text) {
  await loc.click({ clickCount: 3 });
  await loc.fill(text);
  await loc.press("Enter");
  await sleep(200);
}
const LH = "Line height (px, 150% or 1.5×; empty for auto)";
const LS = "Letter spacing (px or %)";

try {
  // 1. Units in the panel (O4, O9, O10).
  {
    const p = await fresh();
    await tool(p, "create_nodes", { nodes: [{ type: "text", name: "T", x: 40, y: 40, text: "Units test", fontSize: 16 }] });
    const id = (await named(p, "T")).id;
    await select(p, [id]);
    await sleep(300);
    await type(field(p, LH), "150%");
    check("O4: line height 150% on 16 px -> 24 px", (await named(p, "T")).text.lineHeight === 24, String((await named(p, "T")).text.lineHeight));
    check("the field shows 24", (await field(p, LH).inputValue()) === "24");
    await type(field(p, LH), "");
    check("O9: an empty line height -> Auto", (await named(p, "T")).text.lineHeight == null);
    check("the field shows Auto", (await field(p, LH).inputValue()) === "Auto");
    await type(field(p, LH), "1.5");
    check("O10: line height 1.5 is a multiple (24 px)", (await named(p, "T")).text.lineHeight === 24);
    await type(field(p, LH), "28px");
    check("28px -> 28", (await named(p, "T")).text.lineHeight === 28);
    await type(field(p, LH), "1.25em");
    check("1.25em -> 20", (await named(p, "T")).text.lineHeight === 20);
    await type(field(p, LH), "auto");
    check("typing auto -> Auto", (await named(p, "T")).text.lineHeight == null);
    await type(field(p, LH), "nonsense");
    check("unreadable text reverts the field", (await field(p, LH).inputValue()) === "Auto" && (await named(p, "T")).text.lineHeight == null);
    await type(field(p, LS), "10%");
    check("O4: letter spacing 10% on 16 px -> 1.6", (await named(p, "T")).text.letterSpacing === 1.6, String((await named(p, "T")).text.letterSpacing));
    await type(field(p, LS), "2");
    check("letter spacing 2 -> 2 px", (await named(p, "T")).text.letterSpacing === 2);
    await type(field(p, LS), "0.05em");
    check("letter spacing 0.05em -> 0.8", (await named(p, "T")).text.letterSpacing === 0.8);
    // % uses the font size of the moment.
    await type(fieldByAria(p, "Font size"), "40");
    await type(field(p, LH), "150%");
    check("150% follows the new size (40 -> 60)", (await named(p, "T")).text.lineHeight === 60);
    await shot(p, "01-units");

    // The same rule in Claude's tools.
    await tool(p, "update_nodes", { updates: [{ id, fontSize: 16, lineHeight: 1.5, letterSpacing: "10%" }] });
    const t = (await named(p, "T")).text;
    check("AI: lineHeight 1.5 -> 24, letterSpacing \"10%\" -> 1.6", t.lineHeight === 24 && t.letterSpacing === 1.6, `${t.lineHeight} ${t.letterSpacing}`);
    await tool(p, "update_nodes", { updates: [{ id, lineHeight: "150%" }] });
    check("AI: lineHeight \"150%\" -> 24", (await named(p, "T")).text.lineHeight === 24);
    await tool(p, "update_nodes", { updates: [{ id, lineHeight: "auto" }] });
    check("AI: lineHeight \"auto\" -> Auto", (await named(p, "T")).text.lineHeight == null);
    await p.context().close();
  }

  // 2. The text style editor uses the same rule.
  {
    const p = await fresh();
    await tool(p, "define_styles", { texts: [{ name: "Body", fontSize: 20, fontWeight: 400 }] });
    await select(p, []);
    await sleep(200);
    // Open the style for editing (double-click its name in the Styles list).
    await p.getByRole("tab", { name: /assets/i }).click();
    await p.waitForSelector("[data-styles=text]");
    await p.locator("[data-styles=text] .wf-style-name", { hasText: "Body" }).first().dblclick();
    await sleep(300);
    const lh = p.locator(`.wf-style-edit label.field[title="${LH}"] input`).first();
    const ls = p.locator(`.wf-style-edit label.field[title="${LS}"] input`).first();
    check("style editor opens", (await lh.count()) === 1);
    const style = async () => (await doc(p)).styles.texts.find((s) => s.name === "Body");
    await type(lh, "150%");
    check("style: 150% on 20 px -> 30", (await style()).lineHeight === 30, String((await style()).lineHeight));
    await type(lh, "");
    check("style: empty -> Auto", (await style()).lineHeight == null && (await lh.inputValue()) === "Auto");
    await type(lh, "1.5");
    check("style: 1.5 -> multiple (30)", (await style()).lineHeight === 30);
    await type(ls, "10%");
    check("style: letter spacing 10% -> 2", (await style()).letterSpacing === 2);
    await shot(p, "02-style-editor");
    await p.context().close();
  }

  // 3. O2/O3: values of the selected characters while editing.
  {
    const p = await fresh();
    const text = "Hello world paragraph.";
    await tool(p, "create_nodes", { nodes: [{ type: "text", name: "Rich", x: 40, y: 40, text, fontSize: 16, width: 400 }] });
    const id = (await named(p, "Rich")).id;
    // "world" bold, "paragraph." 32 px.
    await p.evaluate((id) => {
      window.__dt.dispatch({ op: "styleText", id, start: 6, end: 11, style: { fontWeight: 700 }, clear: [] });
      window.__dt.dispatch({ op: "styleText", id, start: 12, end: 22, style: { fontSize: 32 }, clear: [] });
    }, id);
    await select(p, [id]);
    await p.evaluate(() => window.__dt.zoomToFit?.());
    await p.keyboard.press("Enter");
    await sleep(400);
    const ta = p.locator("textarea.text-editor");
    check("text editor opened", (await ta.count()) === 1);
    const selectRange = async (a, b) => {
      // Real key presses, so the editor tracks the selection as it does for a person.
      await ta.focus();
      await p.keyboard.press("Control+Home");
      for (let i = 0; i < a; i++) await p.keyboard.press("ArrowRight");
      for (let i = a; i < b; i++) await p.keyboard.press("Shift+ArrowRight");
      await sleep(250);
    };
    const weightShown = () => p.locator('[aria-label="Font weight"]').first().evaluate((el) => el.options[el.selectedIndex]?.text ?? el.value);
    const sizeShown = () => fieldByAria(p, "Font size").inputValue();
    await selectRange(0, 5);
    check("O2: 'Hello' shows Regular / 16", (await weightShown()) === "Regular" && (await sizeShown()) === "16", `${await weightShown()} ${await sizeShown()}`);
    await selectRange(6, 11);
    check("O2: 'world' shows Bold / 16", (await weightShown()) === "Bold" && (await sizeShown()) === "16", `${await weightShown()} ${await sizeShown()}`);
    await selectRange(12, 22);
    check("O2: 'paragraph.' shows Regular / 32", (await weightShown()) === "Regular" && (await sizeShown()) === "32", `${await weightShown()} ${await sizeShown()}`);
    await selectRange(4, 8);
    check("a range across a run edge shows Mixed weight", /mixed/i.test(await weightShown()));
    await selectRange(0, 22);
    check("the whole text shows Mixed size", (await sizeShown()) === "Mixed");

    // O3: B on a bold range removes the bold.
    const boldBtn = p.locator('button[title="Bold"]').first();
    await selectRange(6, 11);
    check("O3: B is on for the bold range", (await boldBtn.getAttribute("aria-pressed")) === "true");
    await shot(p, "03-range-bold");
    await boldBtn.click();
    await sleep(300);
    let n = await named(p, "Rich");
    const run = (n.text.runs ?? []).find((r) => r.start <= 6 && r.end >= 11);
    check("O3: B on the bold range sets weight 400 on that range", run?.fontWeight === 400 || !run || run.fontWeight === undefined, JSON.stringify(n.text.runs));
    check("the layer's weight is still 400 and no run stays bold over 'world'", !(n.text.runs ?? []).some((r) => r.fontWeight === 700 && r.start < 11 && r.end > 6), JSON.stringify(n.text.runs));
    await selectRange(6, 11);
    check("B is off afterwards", (await boldBtn.getAttribute("aria-pressed")) !== "true");
    await boldBtn.click();
    await sleep(300);
    n = await named(p, "Rich");
    check("B on a regular range makes it bold", (n.text.runs ?? []).some((r) => r.fontWeight === 700 && r.start <= 6 && r.end >= 11), JSON.stringify(n.text.runs));
    // Fill swatch follows the range colour.
    await p.evaluate((id) => window.__dt.dispatch({ op: "styleText", id, start: 0, end: 5, style: { color: "#ff0000" }, clear: [] }), id);
    await selectRange(0, 5);
    const hex = await p.locator(".panel.right input").evaluateAll((els) => els.map((e) => e.value).filter((v) => /^[0-9A-F]{6}$/i.test(v)));
    check("the Fill row shows the range colour", hex.includes("FF0000"), hex.join(","));
    await p.context().close();
  }

  // 4. Papercut: text in auto layout shows Hug / Fixed that match its resize mode.
  {
    const p = await fresh();
    await tool(p, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Stack", x: 0, y: 0, width: 300, height: 200, layout: { direction: "vertical", gap: 8, padding: 10 },
          children: [{ type: "text", name: "Auto text", text: "Hug me", fontSize: 16 }],
        },
      ],
    });
    const t0 = await named(p, "Auto text");
    await select(p, [t0.id]);
    await sleep(300);
    const wSel = p.locator('[aria-label="Width sizing"]').first();
    const hSel = p.locator('[aria-label="Height sizing"]').first();
    const val = (l) => l.evaluate((el) => el.options[el.selectedIndex].text);
    check("auto-width text shows W Hug and H Hug", (await val(wSel)) === "Hug" && (await val(hSel)) === "Hug", `${await val(wSel)} / ${await val(hSel)} (autoResize ${t0.text.autoResize})`);
    await shot(p, "04-hug");
    await wSel.selectOption({ label: "Fixed" });
    await sleep(300);
    let t = await named(p, "Auto text");
    check("W Fixed makes autoResize height", t.text.autoResize === "height", t.text.autoResize);
    check("then W shows Fixed and H Hug", (await val(wSel)) === "Fixed" && (await val(hSel)) === "Hug");
    await hSel.selectOption({ label: "Fixed" });
    await sleep(300);
    t = await named(p, "Auto text");
    check("H Fixed makes autoResize none", t.text.autoResize === "none", t.text.autoResize);
    await wSel.selectOption({ label: "Hug" });
    await sleep(300);
    t = await named(p, "Auto text");
    check("W Hug makes autoResize width again", t.text.autoResize === "width", t.text.autoResize);
    await wSel.selectOption({ label: "Fill" });
    await sleep(300);
    check("W Fill shows Fill", (await val(wSel)) === "Fill");
    await p.context().close();
  }

  // 5. V-2: X/Y of a layer inside a group are measured from its frame.
  {
    const p = await fresh();
    await tool(p, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Frame", x: 50, y: 50, width: 600, height: 400,
          children: [
            { type: "rectangle", name: "Rect", x: 100, y: 100, width: 80, height: 80 },
            { type: "ellipse", name: "Ellipse", x: 320, y: 100, width: 80, height: 80 },
          ],
        },
      ],
    });
    const rect = await named(p, "Rect");
    const ell = await named(p, "Ellipse");
    await select(p, [rect.id, ell.id]);
    await p.evaluate((ids) => window.__dt.dispatch({ op: "group", ids }), [rect.id, ell.id]);
    await sleep(300);
    const group = (await doc(p)).nodes[(await named(p, "Ellipse")).parent];
    check("the layers are grouped", group?.type === "group", group?.type);
    await select(p, [ell.id]);
    await sleep(300);
    const x = fieldByAria(p, "X position");
    const y = fieldByAria(p, "Y position");
    check("V-2: the group child's X shows 320 (from the frame), Y 100", (await x.inputValue()) === "320" && (await y.inputValue()) === "100", `${await x.inputValue()} / ${await y.inputValue()}; parent-relative x is ${(await named(p, "Ellipse")).x}`);
    await shot(p, "05-group-child-xy");
    await type(x, "0");
    const page = async () => {
      const d = await doc(p);
      const e = Object.values(d.nodes).find((n) => n.name === "Ellipse");
      const g = d.nodes[e.parent];
      const f = d.nodes[g.parent];
      return { x: f.x + g.x + e.x, y: f.y + g.y + e.y, frame: f };
    };
    let pos = await page();
    check("typing 0 puts the ellipse at the frame's edge (page x 50)", Math.abs(pos.x - 50) < 0.01 && Math.abs(pos.y - 150) < 0.01, `${pos.x}, ${pos.y}`);
    check("the field shows 0", (await x.inputValue()) === "0");
    await select(p, [ell.id]);
    await p.keyboard.press("Control+z");
    await sleep(300);
    pos = await page();
    check("one Ctrl+Z restores it (page x 370)", Math.abs(pos.x - 370) < 0.01, String(pos.x));
    // Two children of the group at once: typing moves both to the same frame X.
    await select(p, [rect.id, ell.id]);
    await sleep(250);
    check("two group children with different X show Mixed", (await x.inputValue()) === "Mixed");
    await type(x, "10");
    const d = await doc(p);
    const r2 = Object.values(d.nodes).find((n) => n.name === "Rect");
    const e2 = Object.values(d.nodes).find((n) => n.name === "Ellipse");
    const g2 = d.nodes[e2.parent];
    check("typing 10 puts both at frame x 10", Math.abs(g2.x + r2.x - 10) < 0.01 && Math.abs(g2.x + e2.x - 10) < 0.01, `${g2.x + r2.x}, ${g2.x + e2.x}`);
    await p.keyboard.press("Control+z");
    await sleep(300);
    const d3 = await doc(p);
    const e3 = Object.values(d3.nodes).find((n) => n.name === "Ellipse");
    const r3 = Object.values(d3.nodes).find((n) => n.name === "Rect");
    const g3 = d3.nodes[e3.parent];
    check("one Ctrl+Z undoes both", Math.abs(g3.x + e3.x - 320) < 0.01 && Math.abs(g3.x + r3.x - 100) < 0.01, `${g3.x + r3.x}, ${g3.x + e3.x}`);
    // A layer that isn't in a group keeps parent-relative X.
    await select(p, [(await named(p, "Frame")).id]);
    await sleep(200);
    check("a top-level frame shows its own X (50)", (await x.inputValue()) === "50");
    await p.context().close();
  }

  // 6. B/I/U/S with no range on a layer that has a differently styled word.
  {
    const p = await fresh();
    await tool(p, "create_nodes", { nodes: [{ type: "text", name: "Head", x: 40, y: 40, text: "Big bold heading", fontSize: 24, fontWeight: 700, width: 400 }] });
    const id = (await named(p, "Head")).id;
    await p.evaluate((id) => window.__dt.dispatch({ op: "styleText", id, start: 4, end: 8, style: { fontWeight: 400 }, clear: [] }), id);
    await select(p, [id]);
    await sleep(300);
    const boldBtn = p.locator('button[title="Bold"]').first();
    let n = await named(p, "Head");
    check("setup: base bold with one regular word", n.text.fontWeight === 700 && (n.text.runs ?? []).some((r) => r.fontWeight === 400), JSON.stringify(n.text.runs));
    await boldBtn.click();
    await sleep(300);
    n = await named(p, "Head");
    check("B with no range makes the whole layer bold (no run keeps 400)", n.text.fontWeight === 700 && !(n.text.runs ?? []).some((r) => r.fontWeight !== undefined && r.fontWeight < 700), JSON.stringify(n.text.runs));
    check("B is on now", (await boldBtn.getAttribute("aria-pressed")) === "true");
    await boldBtn.click();
    await sleep(300);
    n = await named(p, "Head");
    check("B again makes the layer regular", n.text.fontWeight === 400);
    await p.keyboard.press("Control+z");
    await sleep(200);
    check("one Ctrl+Z undoes the toggle", (await named(p, "Head")).text.fontWeight === 700);
    await p.context().close();
  }

  // 7. A range selected: the Fill list keeps the real paints.
  {
    const p = await fresh();
    await tool(p, "create_nodes", { nodes: [{ type: "text", name: "Two fills", x: 40, y: 40, text: "Hello world", fontSize: 24, width: 300 }] });
    const id = (await named(p, "Two fills")).id;
    await p.evaluate(
      (id) =>
        window.__dt.dispatch({
          op: "update",
          ids: [id],
          patch: { fills: [{ type: "solid", color: "#112233", opacity: 1, visible: true }, { type: "solid", color: "#445566", opacity: 1, visible: true }] },
        }),
      id,
    );
    await select(p, [id]);
    await p.evaluate(() => window.__dt.zoomToFit?.());
    await p.keyboard.press("Enter");
    await sleep(400);
    const ta = p.locator("textarea.text-editor");
    await ta.focus();
    await p.keyboard.press("Control+Home");
    for (let i = 0; i < 5; i++) await p.keyboard.press("Shift+ArrowRight");
    await sleep(250);
    const fills = async () => (await named(p, "Two fills")).fills.map((f) => f.color.toUpperCase() + (f.opacity === 1 ? "" : `@${f.opacity}`));
    await p.locator('button[title="Add fill"]').first().click();
    await sleep(250);
    check("+ adds to the real fills (3, none replaced)", (await fills()).length === 3 && (await fills())[0] === "#112233" && (await fills())[1] === "#445566", (await fills()).join(","));
    await p.locator('.panel.right button[title="Remove"]').first().click();
    await sleep(250);
    check("Remove drops one real fill, not all", (await fills()).length === 2, (await fills()).join(","));
    // Range colour edit styles only the range.
    await ta.focus();
    await p.keyboard.press("Control+Home");
    for (let i = 0; i < 5; i++) await p.keyboard.press("Shift+ArrowRight");
    await sleep(250);
    const at = await p.locator(".panel.right input").evaluateAll((els) => els.findIndex((e) => e.value === "112233"));
    check("the top fill row shows the range colour (112233)", at >= 0);
    const input = p.locator(".panel.right input").nth(at);
    await input.click({ clickCount: 3 });
    await input.fill("FF0000");
    await input.press("Enter");
    await sleep(300);
    const n = await named(p, "Two fills");
    check("a colour typed on the range row styles only the range", (n.text.runs ?? []).some((r) => r.color && r.color.toUpperCase() === "#FF0000" && r.start === 0 && r.end === 5), JSON.stringify(n.text.runs));
    check("and the real fills stay", n.fills[0].color.toUpperCase() === "#112233" && n.fills.length === 2, (await fills()).join(","));
    await shot(p, "07-range-fills");
    await p.context().close();
  }

  // 8. Flipped group: X/Y are the box's position in the frame.
  {
    const p = await fresh();
    await tool(p, "create_nodes", {
      nodes: [
        {
          type: "frame", name: "Frame", x: 0, y: 0, width: 600, height: 400,
          children: [
            { type: "rectangle", name: "Left", x: 100, y: 100, width: 40, height: 40 },
            { type: "rectangle", name: "Right", x: 300, y: 100, width: 40, height: 40 },
          ],
        },
      ],
    });
    const left = await named(p, "Left");
    const right = await named(p, "Right");
    await p.evaluate((ids) => window.__dt.dispatch({ op: "group", ids }), [left.id, right.id]);
    const gid = (await named(p, "Left")).parent;
    await p.evaluate((ids) => window.__dt.dispatch({ op: "flip", ids, horizontal: true }), [gid]);
    await sleep(300);
    const box = async (name) => {
      const d = await doc(p);
      const nd = Object.values(d.nodes).find((x) => x.name === name);
      const m = (await p.evaluate((id) => window.__dt.query({ q: "bounds", ids: [id] }), nd.id)).items[0].matrix;
      const x0 = m.e;
      const x1 = m.e + m.a * nd.width;
      return Math.min(x0, x1);
    };
    await select(p, [left.id]);
    await sleep(300);
    const x = fieldByAria(p, "X position");
    const shown = Number(await x.inputValue());
    const real = await box("Left");
    check("flipped group: the shown X is the box's page x (frame at 0)", Math.abs(shown - real) < 0.01, `shown ${shown}, real ${real}`);
    await type(x, "50");
    const after = await box("Left");
    check("typing 50 puts the box at page x 50", Math.abs(after - 50) < 0.01, String(after));
    await p.keyboard.press("Control+z");
    await sleep(200);
    check("Ctrl+Z restores it", Math.abs((await box("Left")) - real) < 0.01);
    await p.context().close();
  }

  // 9. Multi-selection reads % per layer, and Enter on an untouched field changes nothing.
  {
    const p = await fresh();
    await tool(p, "create_nodes", {
      nodes: [
        { type: "text", name: "Small", x: 20, y: 20, text: "small", fontSize: 16 },
        { type: "text", name: "Large", x: 20, y: 80, text: "large", fontSize: 40 },
      ],
    });
    const a = await named(p, "Small");
    const b = await named(p, "Large");
    await select(p, [a.id, b.id]);
    await sleep(300);
    await type(field(p, LH), "150%");
    const lhs = [(await named(p, "Small")).text.lineHeight, (await named(p, "Large")).text.lineHeight];
    check("150% on two layers: each uses its own size (24 and 60)", lhs[0] === 24 && lhs[1] === 60, lhs.join(","));
    await type(field(p, LS), "10%");
    const lss = [(await named(p, "Small")).text.letterSpacing, (await named(p, "Large")).text.letterSpacing];
    check("10% letter spacing: 1.6 and 4", lss[0] === 1.6 && lss[1] === 4, lss.join(","));
    await select(p, [a.id]);
    await tool(p, "update_nodes", { updates: [{ id: a.id, lineHeight: "3px" }] });
    await sleep(300);
    const lh = field(p, LH);
    await lh.click();
    await lh.press("Enter");
    await sleep(250);
    check("Enter on an unedited field keeps a 3 px line height", (await named(p, "Small")).text.lineHeight === 3, String((await named(p, "Small")).text.lineHeight));
    await p.context().close();
  }
} catch (e) {
  check("script ran to the end", false, String(e?.stack ?? e));
}

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
