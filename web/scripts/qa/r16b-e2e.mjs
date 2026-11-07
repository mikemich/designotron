// Round 16, r16b: plugin developer experience. R-01 (`done` waits for calls in flight), the plugin
// console, line numbers (runtime, syntax and tool failures), the dialog's Save and Run checking the
// code, running from the editor, the API reference, the URL policy (plain text may hold web
// addresses; image sources, links and fetching stay refused) and tool warnings in the console.
//
// Local servers only: every request that isn't to the editor is aborted and counted.
// Usage: E2E_URL=http://127.0.0.1:6811 [E2E_OUT=dir] node scripts/qa/r16b-e2e.mjs

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:6811";
const OUT = process.env.E2E_OUT ?? "test-results";
fs.mkdirSync(OUT, { recursive: true });

const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? "  - " + String(detail).slice(0, 400) : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch(launch);
const external = []; // requests to anything that isn't the editor
// The editor asks for its Google Fonts stylesheet on load (aborted here); nothing else may leave.
const stray = () => external.filter((u) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u));

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
    // Every toast text, in order (a toast disappears after a few seconds, and only one shows).
    window.__toasts = [];
    new MutationObserver(() => {
      const t = document.querySelector(".toast");
      if (t && window.__toasts[window.__toasts.length - 1] !== t.textContent) window.__toasts.push(t.textContent);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith(URL) || u.startsWith("data:") || u.startsWith("blob:")) return route.continue();
    external.push(u.slice(0, 120));
    route.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("popup", () => errors.push("POPUP opened"));
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.text()));
  await page.goto(URL + "/#/");
  await page.waitForSelector(".files", { timeout: 30000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas", { timeout: 30000 });
  await page.waitForFunction(() => window.__dt?.tool && window.__dt.doc().pages);
  await sleep(400);
  return { ctx, page, errors, consoleLines };
}

const doc = (page) => page.evaluate(() => window.__dt.doc());
const nodes = async (page) => Object.values((await doc(page)).nodes);
const toasts = (page) => page.evaluate(() => window.__toasts);
const running = (page) => page.evaluate(() => window.__dt.plugin());
const logs = (page) => page.evaluate(() => window.__dt.pluginLog());
const logText = async (page) => (await logs(page)).map((e) => `${e.level}: ${e.text}${e.line ? ` @${e.line}` : ""}`);
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, timeout: 8000 }).catch((e) => console.log(`INFO  screenshot ${name} failed: ${String(e).split("\n")[0]}`));

async function addPlugin(page, id, code, name = id) {
  await page.evaluate(
    ([i, c, n]) => {
      const list = JSON.parse(localStorage.getItem("dt:plugins") || "[]").filter((p) => p.id !== i);
      list.push({ id: i, name: n, description: "", code: c });
      localStorage.setItem("dt:plugins", JSON.stringify(list));
    },
    [id, code, name],
  );
}
const run = (page, id) => page.evaluate((i) => window.__dt.runPlugin(i), id);
async function waitStopped(page, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!(await running(page))) return Date.now() - t0;
    await sleep(50);
  }
  return -1;
}
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("dt:plugins") || "[]"));

async function openDialog(page) {
  await page.getByTitle("Main menu").click();
  await page.getByText("Manage plugins…").click();
  await page.waitForSelector(".plugins-dialog");
}
async function newPlugin(page, name, code) {
  await page.getByRole("button", { name: "New plugin" }).click();
  await page.getByPlaceholder("Name").fill(name);
  await page.locator("textarea.code").fill(code);
}
const caretLine = (page) => page.evaluate(() => {
  const ta = document.querySelector("textarea.code");
  return ta.value.slice(0, ta.selectionStart).split("\n").length;
});
const dialogOpen = (page) => page.locator(".plugins-dialog").count().then((n) => n > 0);

// ---------- R-01: an un-awaited failing call is not lost when the body ends at once ----------
{
  console.log("\n# R-01: done waits for calls in flight (5 runs)");
  const { ctx, page } = await open();
  await addPlugin(page, "r01", '// first line\n// second line\ndt.tool("update_nodes", { updates: [{ id: "n_missing" }] }); dt.notify("fired");', "Fire and forget");
  let allToast = 0;
  let allLog = 0;
  let allNotify = 0;
  for (let i = 1; i <= 5; i++) {
    await run(page, "r01");
    const took = await waitStopped(page, 8000);
    await sleep(150);
    const t = await toasts(page);
    const l = await logText(page);
    const errToast = t.slice(-3).some((x) => /update_nodes failed \(line 3\): .*n_missing/.test(x));
    const failLine = l.some((x) => /^error: update_nodes failed \(line 3\): .*n_missing @3$/.test(x));
    const notified = l.some((x) => x === "notify: fired @3");
    if (errToast) allToast++;
    if (failLine) allLog++;
    if (notified) allNotify++;
    console.log(`INFO  run ${i}: stopped in ${took} ms; log=${JSON.stringify(l)}`);
    await sleep(300);
  }
  check("the failure's error toast shows in 5 of 5 runs", allToast === 5, `${allToast}/5`);
  check("the console has the failure with its line in 5 of 5 runs", allLog === 5, `${allLog}/5`);
  check("the console has the notify in 5 of 5 runs", allNotify === 5, `${allNotify}/5`);
  check("the run still ends by itself", (await running(page)) === null);

  // An un-awaited call that succeeds still lands when the body ends at once.
  await addPlugin(page, "r01b", 'dt.tool("create_nodes", { nodes: [{ type: "rectangle", name: "NOAWAIT", width: 10, height: 10 }] });', "No await");
  await run(page, "r01b");
  await waitStopped(page, 5000);
  check("an un-awaited call that succeeds is applied", (await nodes(page)).some((n) => n.name === "NOAWAIT"));
  await ctx.close();
}

// ---------- Console ----------
{
  console.log("\n# Console: console.*, throttling, order");
  const { ctx, page } = await open();
  await addPlugin(page, "c1", 'console.log({ a: 1 }, "x");\nconsole.info("i");\nconsole.warn("w", [1, 2]);\nconsole.error(new Error("boom"));\nconst o = { n: 1 }; o.self = o; console.log(o);\nconsole.debug(undefined, Symbol("s"));', "Console");
  await run(page, "c1");
  await waitStopped(page, 5000);
  const l = await logText(page);
  check('console.log({a:1}, "x") appears as {"a":1} x', l.includes('log: {"a":1} x @1'), JSON.stringify(l));
  check("info, warn and error keep their level, with lines", l.includes("info: i @2") && l.includes("warn: w [1,2] @3") && l.includes("error: Error: boom @4"), JSON.stringify(l));
  check("a cycle prints, and debug is a log line", l.includes('log: {"n":1,"self":"[Circular]"} @5') && l.includes("log: undefined Symbol(s) @6"), JSON.stringify(l));
  check("the run ends with a Done line, after the output", l[l.length - 1] === "info: Done", l[l.length - 1]);

  // Order: a log line before a notify and before a failing call stays before it.
  await addPlugin(page, "c2", 'console.log("one"); dt.notify("two"); console.log("three"); await dt.tool("get_document", {}); console.log("four");', "Order");
  await run(page, "c2");
  await waitStopped(page, 5000);
  const o = (await logText(page)).filter((x) => !x.startsWith("info: Done")).map((x) => x.replace(/ @\d+$/, ""));
  check("lines keep their order across calls", JSON.stringify(o) === JSON.stringify(["log: one", "notify: two", "log: three", "log: four"]), JSON.stringify(o));

  // A hot loop.
  await page.evaluate(() => {
    window.__gaps = [];
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      window.__gaps.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await addPlugin(page, "c3", 'for (let i = 0; i < 10000; i++) console.log("line " + i);\nawait new Promise((r) => setTimeout(r, 400));\nfor (let i = 0; i < 10000; i++) console.log("again " + i);', "Hot loop");
  const t0 = Date.now();
  await run(page, "c3");
  const took = await waitStopped(page, 20000);
  await sleep(300);
  const big = await logs(page);
  const gap = await page.evaluate(() => Math.max(...window.__gaps));
  check("a 2 x 10,000 line log loop leaves at most 500 entries", big.length <= 500 && big.length > 0, `${big.length} entries`);
  check("it says how many lines were dropped", big.some((e) => /^\(\d+ lines dropped\)$/.test(e.text)), JSON.stringify(big.filter((e) => /dropped/.test(e.text)).slice(0, 2)));
  check("the editor stays responsive (longest frame gap under 1 s)", gap < 1000, `${Math.round(gap)} ms, run took ${took} ms (${Date.now() - t0} ms wall)`);
  await ctx.close();
}

// ---------- Line numbers: runtime errors, syntax errors, tool failures ----------
{
  console.log("\n# Line numbers");
  const { ctx, page } = await open();
  await addPlugin(page, "rt", "const a = 1;\nnull.x;\nconsole.log(a);", "Runtime error");
  await run(page, "rt");
  await waitStopped(page, 5000);
  await sleep(200);
  const t = await toasts(page);
  check("a runtime error on line 2 says 'line 2'", t.some((x) => /Plugin “Runtime error” failed at line 2: TypeError/.test(x)), JSON.stringify(t));
  const l = await logText(page);
  check("and the console has it with the line", l.some((x) => /^error: TypeError: .* @2$/.test(x)), JSON.stringify(l));

  await addPlugin(page, "rt1", 'throw new Error("first line");', "Line one");
  await run(page, "rt1");
  await waitStopped(page, 5000);
  check("an error on line 1 says 'line 1'", (await logText(page)).some((x) => /^error: Error: first line @1$/.test(x)), JSON.stringify(await logText(page)));

  await addPlugin(page, "rt3", "// a\n\n\n  await Promise.resolve();\n  undefinedFunction();", "After await");
  await run(page, "rt3");
  await waitStopped(page, 5000);
  check("an error after an await is mapped too (line 5)", (await logText(page)).some((x) => /^error: ReferenceError: .* @5$/.test(x)), JSON.stringify(await logText(page)));

  // A run that has syntax errors (stored directly, so the dialog's check doesn't stop it).
  await addPlugin(page, "se", "const a = 1;\nconst b = 2;\nlet x = ;\nconsole.log(a, b);", "Syntax error");
  await run(page, "se");
  await waitStopped(page, 5000);
  await sleep(200);
  const t2 = await toasts(page);
  check("a stored syntax error on line 3 is reported with its line at run time", t2.some((x) => /Plugin “Syntax error” failed at line 3: SyntaxError/.test(x)), JSON.stringify(t2.slice(-2)));

  await addPlugin(page, "tf", "// x\nconst r = await dt.tool('update_nodes', { updates: [{ id: 'n_missing' }] });", "Awaited failure");
  await run(page, "tf");
  await waitStopped(page, 5000);
  const t3 = await toasts(page);
  check("an awaited tool failure names the call's line", t3.some((x) => /failed at line 2: update_nodes failed \(line 2\): .*n_missing/.test(x)), JSON.stringify(t3.slice(-2)));

  // A plugin's own Error.prepareStackTrace can't break the report.
  await addPlugin(page, "ps", 'Error.prepareStackTrace = () => "<anonymous>:99999:1 https://example.com";\nnull.x;', "Hostile stack");
  await run(page, "ps");
  const stopped = await waitStopped(page, 5000);
  check("a hostile Error.prepareStackTrace gets no bogus line and the run still ends", stopped >= 0 && !(await logText(page)).some((x) => /@99999/.test(x)), JSON.stringify(await logText(page)));
  await ctx.close();
}

// ---------- The dialog: Save and Run check the code; run from the editor ----------
{
  console.log("\n# Dialog");
  const { ctx, page, errors } = await open();
  await openDialog(page);

  // Blank code
  await page.getByRole("button", { name: "New plugin" }).click();
  await page.getByPlaceholder("Name").fill("Blank");
  await page.locator("textarea.code").fill("   \n  ");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForSelector(".plugin-problem");
  check("blank code: Save is refused with a message", /no code/i.test(await page.locator(".plugin-problem").innerText()), await page.locator(".plugin-problem").innerText());
  check("and nothing is stored", (await stored(page)).length === 0);

  // Syntax error on line 3
  await page.locator("textarea.code").fill("// one\nconst a = 1;\nlet x = ;\nconsole.log(a);");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForSelector(".plugin-problem");
  const msg = await page.locator(".plugin-problem").innerText();
  check("a syntax error on line 3 shows 'Line 3, column N: message'", /^Line 3, column \d+: Unexpected token/.test(msg.replace(/\s+/g, " ")), msg);
  check("the caret is on line 3", (await caretLine(page)) === 3, await caretLine(page));
  check("and nothing is stored", (await stored(page)).length === 0);
  await shot(page, "dialog-syntax-error");
  check("the gutter numbers the lines", (await page.locator(".code-gutter").innerText()).trim().split("\n").join(",") === "1,2,3,4");

  // Run is refused the same way, and runs nothing
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.waitForSelector(".plugin-problem");
  check("Run is refused too, and the dialog stays", (await dialogOpen(page)) && (await running(page)) === null);

  // Editing clears the message; valid code saves
  await page.locator("textarea.code").fill('// ok\nconsole.log("saved ok");');
  check("editing clears the message", (await page.locator(".plugin-problem").count()) === 0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForSelector(".plugin-list");
  check("valid code saves and returns to the list", (await stored(page)).some((p) => p.name === "Blank" && /saved ok/.test(p.code)));

  // Run from the editor keeps the dialog open and the console fills
  await page.locator(".plugin-row", { hasText: "Blank" }).locator("div").first().click();
  await page.locator("textarea.code").fill('console.log("hello from the editor");\ndt.notify("n1");\nconsole.warn("careful");');
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".plugin-console-body")?.textContent?.includes("Done"), null, { timeout: 8000 });
  check("Run keeps the dialog open", await dialogOpen(page));
  const body = await page.locator(".plugin-console-body").innerText();
  check("the console pane shows that run live", /hello from the editor/.test(body) && /n1/.test(body) && /careful/.test(body), body.replace(/\s+/g, " "));
  await shot(page, "dialog-console");
  // Clicking a line number moves the caret
  await page.locator(".plugin-console-body .plugin-log-line", { hasText: "line 3" }).first().click();
  check("clicking a console line number moves the caret there", (await caretLine(page)) === 3, await caretLine(page));
  // Clear
  await page.getByRole("button", { name: "Clear" }).click();
  check("Clear empties the console", (await page.locator(".plugin-console-body .plugin-log").count()) === 0);
  // Ctrl+Enter
  await page.locator("textarea.code").focus();
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.querySelector(".plugin-console-body")?.textContent?.includes("hello from the editor"), null, { timeout: 8000 });
  check("Ctrl+Enter in the code runs it", true);
  await sleep(300);

  // A runtime error shows in the console with its line, and clicking goes there
  await page.locator("textarea.code").fill("const a = 1;\nnull.x;");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => /TypeError/.test(document.querySelector(".plugin-console-body")?.textContent ?? ""), null, { timeout: 8000 });
  check("a runtime error shows in the console with its line", /line 2/.test(await page.locator(".plugin-console-body").innerText()));

  // A UI plugin closes the dialog; its Console toggle shows the log
  await page.locator("textarea.code").fill('dt.ui.show("<p style=\\"color:#fff\\">panel</p>", { width: 260, height: 120 });\nconsole.log("from the panel plugin");');
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.waitForSelector(".plugin-header", { timeout: 8000 });
  await sleep(300);
  check("a plugin that shows UI closes the dialog", !(await dialogOpen(page)));
  check("its header has a Console toggle that opens the log", (await page.locator(".plugin-console-float").count()) === 0);
  await page.getByRole("button", { name: "Console" }).click();
  await page.waitForSelector(".plugin-console-float");
  check("the floating console shows the run", /from the panel plugin/.test(await page.locator(".plugin-console-float").innerText()));
  await shot(page, "panel-console");
  await page.getByRole("button", { name: "Console" }).click();
  check("the toggle closes it again", (await page.locator(".plugin-console-float").count()) === 0);
  await page.getByTitle("Close plugin").click();
  check("closing the plugin ends the run", (await waitStopped(page, 2000)) >= 0);

  // API reference
  await openDialog(page);
  await page.locator(".plugin-row", { hasText: "Blank" }).locator("div").first().click();
  await page.locator(".plugin-api summary").click();
  const api = await page.locator(".plugin-api").innerText();
  check('the API reference lists on("selectionchange") and commitUndo', /selectionchange/.test(api) && /commitUndo/.test(api));
  check("it lists every dt function", ["dt.tool", "dt.selection", "dt.getDocument", "dt.getNodes", "dt.notify", "dt.close", "dt.commitUndo", "dt.ui.show", "console.log"].every((s) => api.includes(s)));
  check("it documents the getDocument shape", ["currentPage", "nextFreeX", "colorStyles", "variables", "components", "layers"].every((s) => api.includes(s)) && /\bw, h\b/.test(api));
  check("it says getNodes and selection return full nodes", /full nodes/.test(api) && /fills, width, height/.test(api));
  check("it states the undo rules and the URL policy", /one undo step/i.test(api) && /commitUndo/.test(api) && /Web addresses/.test(api) && /import_url/.test(api));
  await shot(page, "dialog-api");
  await page.getByRole("button", { name: "Back" }).click();
  const safety = await page.locator(".plugin-list").innerText();
  check("the safety text no longer says a plugin could navigate its frame", !/navigating its frame/.test(safety) && /Chromium/.test(safety) && /only run plugins you trust/.test(safety), safety.slice(-420));
  check("no page errors, popups or requests beyond the editor's own font stylesheet", errors.length === 0 && stray().length === 0, JSON.stringify({ errors, stray: stray() }));
  await ctx.close();
}

// ---------- Save and Run never execute code that only fails to compile ----------
{
  console.log("\n# Diagnosis never runs plugin code");
  const { ctx, page, consoleLines } = await open();
  // Invalid under the run wrapper (let dt clashes with its parameter), but after the early "})" it is a
  // valid script: a diagnosis that evaluated it would run the console.log and the tool call.
  const escape = '// one\n}); console.log("ESCAPED-MARKER"); window.dt.tool("create_nodes", { nodes: [{ type: "rectangle", name: "ESCAPED", width: 5, height: 5 }] }); window.__ran = 1; let dt = 1; (async function(){\n';
  await openDialog(page);
  await newPlugin(page, "Escaper", escape);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForSelector(".plugin-problem");
  await sleep(500);
  const msg = await page.locator(".plugin-problem").innerText();
  check("Save refuses code that closes the wrapper early", msg.length > 0, msg);
  check("and nothing is stored", (await stored(page)).length === 0);
  check("Save executed none of it: no console line, no layer", !consoleLines.some((l) => /ESCAPED-MARKER/.test(l)) && !(await nodes(page)).some((n) => n.name === "ESCAPED"), JSON.stringify(consoleLines.filter((l) => /ESCAPED/.test(l))));
  // The real error is still found, with its line, in code that also closes the wrapper early.
  await page.locator("textarea.code").fill('// one\n});\nlet x = ;\nconsole.log("ESCAPED-MARKER");');
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForSelector(".plugin-problem");
  const m2 = (await page.locator(".plugin-problem").innerText()).replace(/\s+/g, " ");
  check("a real syntax error is still reported with its line", /^Line 3, column \d+: Unexpected token/.test(m2), m2);
  check("and that ran nothing either", !consoleLines.some((l) => /ESCAPED-MARKER/.test(l)));
  await ctx.close();

  // Run of a stored plugin that only fails to compile: reported as a SyntaxError, nothing executed.
  const b = await open();
  await addPlugin(b.page, "esc", escape, "Escaper run");
  await run(b.page, "esc");
  await waitStopped(b.page, 5000);
  await sleep(300);
  const t = await toasts(b.page);
  check("Run reports a SyntaxError", t.some((x) => /Plugin “Escaper run” failed.*SyntaxError/.test(x)), JSON.stringify(t));
  check("Run executed none of it: no console line, no layer, no marker", !b.consoleLines.some((l) => /ESCAPED-MARKER/.test(l)) && !(await nodes(b.page)).some((n) => n.name === "ESCAPED") && !(await logText(b.page)).some((x) => /ESCAPED/.test(x)), JSON.stringify(await logText(b.page)));
  await b.ctx.close();
}

// ---------- Runtime errors in the dialog flow: runtime error plus saved plugin ----------
{
  console.log("\n# Saved plugin runs");
  const { ctx, page } = await open();
  await openDialog(page);
  await newPlugin(page, "Saved runtime", "const a = 1;\nnull.x;\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForSelector(".plugin-list");
  check("code that compiles but fails at run time saves", (await stored(page)).some((p) => p.name === "Saved runtime"));
  await page.locator(".plugin-row", { hasText: "Saved runtime" }).getByRole("button", { name: /^Run / }).click();
  await waitStopped(page, 5000);
  await sleep(200);
  check("running from the list closes the dialog, and the toast says line 2", !(await dialogOpen(page)) && (await toasts(page)).some((t) => /failed at line 2/.test(t)), JSON.stringify(await toasts(page)));
  await ctx.close();
}

// ---------- R-03: the URL policy ----------
{
  console.log("\n# R-03: web addresses in text are allowed, the rest stays refused");
  const { ctx, page } = await open();
  external.length = 0;
  const code = `
const text = "See https://example.com/docs for more";
const r = await dt.tool("create_nodes", { nodes: [{ type: "text", name: "Link https://example.com/n", text, x: 10, y: 10 }] });
console.log("TEXT-OK " + r.created.length);
const refused = async (label, input) => {
  try { await dt.tool("create_nodes", input); console.log(label + " ALLOWED"); }
  catch (e) { console.log(label + " REFUSED " + e.message); }
};
await refused("IMG", { nodes: [{ type: "image", name: "IMG", imageUrl: "https://example.com/a.png" }] });
await refused("SPANLINK", { nodes: [{ type: "text", name: "SPAN", text: "x", spans: [{ text: "x", link: "https://example.com/l" }] }] });
await refused("FILLSRC", { nodes: [{ type: "rectangle", name: "FILL", fills: [{ type: "image", src: "https://example.com/a.png" }] }] });
await refused("SVG", { nodes: [{ type: "svg", name: "SVG", svg: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>' }] });
await refused("PROTO", { nodes: [{ type: "rectangle", name: "PROTO", prototype: { url: "https://example.com" } }] });
try { await dt.tool("import_url", { url: "https://example.com" }); console.log("FETCH ALLOWED"); } catch (e) { console.log("FETCH REFUSED " + e.message); }
const sp = await dt.tool("create_nodes", { nodes: [{ type: "text", name: "Spans", text: "go to docs", spans: [{ text: "see https://example.com/s" }] }] });
console.log("SPAN-TEXT " + sp.created.length);
`;
  await addPlugin(page, "r03", code, "URLs");
  await run(page, "r03");
  await waitStopped(page, 10000);
  const l = await logText(page);
  const find = (re) => l.find((x) => re.test(x));
  check("a text layer reading 'See https://example.com/docs' is created", /TEXT-OK 1/.test(find(/TEXT-OK/) ?? ""), JSON.stringify(l));
  const made = (await nodes(page)).filter((n) => n.name?.startsWith("Link "));
  check("with that text and name", made.length === 1 && made[0].text?.characters === "See https://example.com/docs for more" && made[0].name === "Link https://example.com/n", JSON.stringify(made.map((n) => [n.name, n.text?.characters])));
  for (const label of ["IMG", "SPANLINK", "FILLSRC", "SVG", "PROTO", "FETCH"]) {
    const line = find(new RegExp(`${label} (REFUSED|ALLOWED)`));
    check(`${label} stays refused`, /REFUSED/.test(line ?? ""), line);
  }
  const ref = find(/IMG REFUSED/) ?? "";
  check("the refusal says what is allowed", /outside text \(no links, image URLs or fetching\)/.test(ref), ref);
  check("span text with a web address is allowed", /SPAN-TEXT 1/.test(find(/SPAN-TEXT/) ?? ""), JSON.stringify(l.slice(-3)));
  const all = await nodes(page);
  check("no refused layer was made", !all.some((n) => ["IMG", "SPAN", "FILL", "SVG", "PROTO"].includes(n.name)));
  check("no request left the editor", stray().length === 0, JSON.stringify(stray()));
  await ctx.close();
}

// ---------- Tool warnings in the console ----------
{
  console.log("\n# Tool warnings");
  const { ctx, page } = await open();
  await addPlugin(page, "tw", '// make one\nconst r = await dt.tool("create_nodes", { nodes: [{ type: "rectangle", name: "W", width: 40, height: 40 }] });\nawait dt.tool("update_nodes", { updates: [{ id: r.created[0].id, padding: 8 }] });', "Warnings");
  await run(page, "tw");
  await waitStopped(page, 5000);
  const l = await logText(page);
  check("a tool warning shows in the console with the call's line", l.some((x) => /^tool: update_nodes: updates\[0\]: unknown key 'padding' ignored @3$/.test(x)), JSON.stringify(l));
  await ctx.close();
}

await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
