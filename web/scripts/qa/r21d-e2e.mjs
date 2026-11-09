// Round 21, r21d: the first hour and the Claude panel.
//   1. The new-file prompt takes focus (typing goes into it, the tool stays Move); an emptied page that has
//      history doesn't take focus.
//   2. The "Ask Claude" hint goes when the panel opens and doesn't come back.
//   3. A bridge without Claude Code: no backtick in the status, a card says the bridge is running.
//   4. All four templates build without overlapping top-level layers.
//   5. The install command isn't cut off.
//   6. Conversation history: archive, open, reload, delete (with confirmation), file delete clears it.
//   7. The shortcut sheet and the Present tooltip carry Ctrl+Alt+Enter.
//   8. A file made from the dashboard prompt is named after it.
//   9. The Help menu: five items, a local help page that loads nothing from outside, Feedback copies details,
//      Show tips again brings hints back.
//  10. Quick actions say why they are disabled.
//  11. No page errors, no browser dialogs.
//
// Local only. Servers (started by hand, see RULES.md):
//   CLAUDE_BIN=$PWD/web/scripts/fixtures/fake-claude.mjs <target>/debug/designotron --port 7635 --static web/dist --workspace <scratch> --no-open
//   CLAUDE_BIN=/nonexistent <target>/debug/designotron --port 7633 --static web/dist --workspace <scratch2> --no-open
//   cd web && DESIGNOTRON_PORT=7635 npx vite preview --port 7631 --host 127.0.0.1 --strictPort
//   cd web && LANG=C.UTF-8 node scripts/qa/r21d-e2e.mjs
// Every non-local request is aborted. Env: E2E_URL (7631) E2E_NOCLI_URL (7633) E2E_OUT (screenshots)

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:7631";
const NOCLI = process.env.E2E_NOCLI_URL ?? "http://127.0.0.1:7633";
const OUT = process.env.E2E_OUT ?? "test-results";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? "  - " + String(detail).slice(0, 400) : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch(launch);
const LOCAL = /^(http:\/\/(localhost|127\.0\.0\.1)|data:|blob:|ws:\/\/(localhost|127\.0\.0\.1))/;
/** Every request any page made, with the URL of the frame that made it, so the help page's can be listed. */
const asked = [];

async function open({ tour = true, base = URL, prefs = {}, perms = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark", ...(perms ? { permissions: ["clipboard-read", "clipboard-write"] } : {}) });
  await ctx.addInitScript(
    ([tour, prefs]) => {
      try {
        if (tour) localStorage.setItem("dt:tour-done", "1");
        for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v);
      } catch {
        /* no storage */
      }
    },
    [tour, prefs],
  );
  await ctx.route("**/*", (r) => {
    const u = r.request().url();
    let from = "";
    try {
      from = r.request().frame().url();
    } catch {
      /* a request with no frame */
    }
    asked.push({ u, from });
    return LOCAL.test(u) ? r.continue() : r.abort();
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => check("no page errors", false, String(e)));
  page.on("dialog", (d) => {
    check("no browser dialog", false, d.message());
    d.dismiss();
  });
  await page.goto(base);
  await page.waitForSelector(".files", { timeout: 30000 });
  return { ctx, page };
}
const newFile = async (page) => {
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas", { timeout: 30000 });
  await sleep(500);
};
const run = (page, cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const active = (page) => page.evaluate(() => ({ id: document.activeElement?.id ?? "", tag: document.activeElement?.tagName ?? "" }));
const addRect = (page) => run(page, { op: "ai", tool: "create_nodes", input: { nodes: [{ type: "rectangle", x: 0, y: 0, width: 120, height: 80, fill: "#ff0000" }] } });
const activeTool = (page) => page.locator(".topbar .tbtn.active[title^='Move']").first().getAttribute("title", { timeout: 2000 }).catch(() => null);
const connected = (page) => page.waitForFunction(() => window.__dt.chat().bridgeStatus === "connected" && window.__dt.chat().claude !== null, null, { timeout: 30000 });

// ---------------------------------------------------------------- 1. prompt focus
{
  const { ctx, page } = await open();
  await newFile(page);
  await page.waitForSelector(".empty-prompt");
  await sleep(300);
  const a = await active(page);
  check("1: a new file's prompt textarea has focus", a.id === "empty-prompt-input", JSON.stringify(a));
  await page.keyboard.type("a landing page", { delay: 15 });
  const v = await page.inputValue("#empty-prompt-input");
  check("1: typing goes into the prompt", v === "a landing page", v);
  check("1: the Move tool is still active and the card is still there", /^Move/.test((await activeTool(page)) ?? "") && (await page.locator(".topbar .tbtn.active[title^='Frame']").count()) === 0 && (await page.locator(".empty-prompt").count()) === 1, await activeTool(page));
  await shot(page, "empty-prompt-focused");
  await ctx.close();

  // A page someone emptied: there is something to undo, so no focus.
  const b = await open();
  await newFile(b.page);
  await addRect(b.page);
  await sleep(300);
  const ids = await b.page.evaluate(() => Object.values(window.__dt.doc().nodes).filter((n) => !n.parent && n.type !== "page").map((n) => n.id));
  await run(b.page, { op: "delete", ids });
  await b.page.waitForSelector(".empty-prompt", { timeout: 5000 });
  await sleep(400);
  const a2 = await active(b.page);
  check("1: a page emptied after editing doesn't take focus", a2.id !== "empty-prompt-input", JSON.stringify(a2));
  await b.ctx.close();
}

// The card comes back after Ctrl+Z without taking the keys, so redo still works.
{
  const { ctx, page } = await open();
  await newFile(page);
  await page.waitForSelector(".empty-prompt");
  await sleep(300);
  await page.locator(".empty-divider + .suggestions button", { hasText: "Landing page" }).click();
  await sleep(800);
  const roots = () => page.evaluate(() => window.__dt.doc().pages.find((p) => p.id === window.__dt.state().page).children.length);
  check("1: the template built layers", (await roots()) > 0);
  await page.keyboard.press("Control+z");
  await page.waitForSelector(".empty-prompt", { timeout: 5000 });
  await sleep(500);
  const a = await active(page);
  check("1: after Ctrl+Z the card is back and doesn't take focus", a.id !== "empty-prompt-input", JSON.stringify(a));
  await page.keyboard.press("Control+Shift+z");
  await sleep(500);
  check("1: Ctrl+Shift+Z brings the layers back", (await roots()) > 0);
  await ctx.close();
}

// ---------------------------------------------------------------- 2. the Ask Claude hint
{
  const { ctx, page } = await open({ tour: false, prefs: { "dt:hint:layers": "1", "dt:hint:design": "1" } });
  await newFile(page);
  await addRect(page);
  await page.waitForFunction(() => /Ask Claude/.test(document.querySelector(".hint-card")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
  const shown = await page.locator(".hint-card").count();
  check("2: the Ask Claude hint shows once a layer exists", shown === 1, String(shown));
  await page.keyboard.press("Control+/");
  await page.waitForSelector(".chat");
  await sleep(100);
  check("2: Ctrl+/ hides it at once", (await page.locator(".hint-card").count()) === 0);
  await page.keyboard.press("Escape");
  await page.locator("button[aria-label='Close Claude panel']").click();
  await sleep(2500);
  check("2: it doesn't come back after closing the panel", (await page.locator(".hint-card").count()) === 0);
  const seen = await page.evaluate(() => localStorage.getItem("dt:hint:claude"));
  check("2: opening Claude counts as having seen the hint", seen === "1", String(seen));
  await ctx.close();
}

// ---------------------------------------------------------------- 3. bridge without Claude Code
{
  const { ctx, page } = await open({ base: NOCLI });
  await newFile(page);
  await page.keyboard.press("Control+/");
  await page.waitForSelector(".chat");
  await page.waitForFunction(() => window.__dt.chat().bridgeStatus === "connected", null, { timeout: 30000 });
  await sleep(500);
  const status = await page.evaluate(() => document.querySelector(".chat .section .small.muted")?.textContent ?? "");
  check("3: the status says Claude Code isn't installed, with no backtick", /Bridge running, but Claude Code isn't installed/.test(status) && !status.includes("`"), status);
  const card = await page.evaluate(() => document.querySelector(".no-cli-card")?.textContent ?? "");
  check("3: the card says the bridge is running and what to do", /The bridge is running\./.test(card) && /claude/.test(card) && /\/login/.test(card), card);
  check("3: the install steps aren't shown", (await page.locator(".bridge-setup details").count()) === 0);
  check("3: the API-key row stays", (await page.locator(".bridge-setup input[aria-label='Anthropic API key']").count()) === 1);
  await shot(page, "no-cli-card");
  await ctx.close();
}

// ---------------------------------------------------------------- 4. templates
{
  const names = ["Mobile app", "Landing page", "Dashboard", "Design system"];
  for (const name of names) {
    const { ctx, page } = await open();
    await newFile(page);
    await page.waitForSelector(".empty-prompt");
    await page.locator(".empty-divider + .suggestions button", { hasText: name }).click();
    await sleep(800);
    const r = await page.evaluate(() => {
      const doc = window.__dt.doc();
      const pageId = window.__dt.state().page;
      const roots = doc.pages.find((p) => p.id === pageId).children;
      const items = window.__dt.query({ q: "bounds", ids: roots }).items;
      const boxes = items.map((i) => ({ id: i.id, name: doc.nodes[i.id].name, ...i.bounds }));
      const hits = [];
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          if (w > 0.5 && h > 0.5) hits.push(`${a.name} x ${b.name} (${Math.round(w)}x${Math.round(h)})`);
        }
      return { n: boxes.length, hits };
    });
    check(`4: template "${name}" has no intersecting top-level layers`, r.n > 0 && r.hits.length === 0, `${r.n} layers; ${r.hits.join(", ")}`);
    if (name === "Design system") await shot(page, "template-design-system");
    await ctx.close();
  }
}

// ---------------------------------------------------------------- 5. the install command isn't cut off
{
  // A bridge address with nothing behind it: Claude stays unconnected and the steps show.
  const { ctx, page } = await open({ prefs: { "dt:bridgeUrl": "ws://127.0.0.1:7637/bridge/ws" } });
  await newFile(page);
  await page.keyboard.press("Control+/");
  await page.waitForSelector(".chat .copy-line code");
  await sleep(500);
  const m = await page.evaluate(() => [...document.querySelectorAll(".chat .copy-line code")].map((c) => ({ text: c.textContent.slice(0, 30), sw: c.scrollWidth, cw: c.clientWidth, h: c.getBoundingClientRect().height })));
  check("5: every command box fits (scrollWidth <= clientWidth + 1)", m.length >= 2 && m.every((x) => x.sw <= x.cw + 1), JSON.stringify(m));
  const copyTop = await page.evaluate(() => {
    const line = document.querySelector(".chat .copy-line");
    const b = line.querySelector("button").getBoundingClientRect();
    const l = line.getBoundingClientRect();
    return b.top - l.top < 12;
  });
  check("5: the Copy button stays at the top of the box", copyTop);
  await shot(page, "code-box");
  await ctx.close();
}

// ---------------------------------------------------------------- 6. conversation history (fake Claude on 7635)
{
  const { ctx, page } = await open({ perms: true });
  await newFile(page);
  const fileId = await page.evaluate(() => location.hash);
  await page.keyboard.press("Control+/");
  await page.waitForSelector(".chat");
  await connected(page);
  const box = page.locator(".chat-input textarea");
  const say = async (text) => {
    await box.fill(text);
    await box.press("Enter");
    await page.waitForFunction((t) => window.__dt.chat().items.some((i) => i.kind === "user" && i.text === t), text);
    await page.waitForFunction(() => !window.__dt.chat().running && window.__dt.chat().items.some((i) => i.kind === "assistant"), null, { timeout: 60000 });
  };
  const past = async () => {
    await page.locator("button[aria-label='Past conversations']").click();
    await page.waitForSelector(".past-menu");
    await sleep(300);
    return page.evaluate(() => [...document.querySelectorAll(".past-menu .past-row .item")].map((e) => e.querySelector(".past-title").textContent));
  };
  await say("make a card");
  const session = await page.evaluate(() => window.__dt.chat().sessionId);
  check("6: the fake Claude answered and there is a session", !!session, String(session));
  await page.locator("button[aria-label='New conversation']").click();
  await sleep(300);
  check("6: New conversation empties the panel", (await page.evaluate(() => window.__dt.chat().items.length)) === 0);
  let list = await past();
  check("6: the past list has one entry titled 'make a card'", list.length === 1 && list[0] === "make a card", JSON.stringify(list));
  await shot(page, "past-menu");
  await page.locator(".past-menu .past-row .item").first().click();
  await page.waitForFunction(() => window.__dt.chat().items.some((i) => i.kind === "user" && i.text === "make a card"), null, { timeout: 5000 });
  const back = await page.evaluate(() => ({ s: window.__dt.chat().sessionId, n: window.__dt.chat().items.length }));
  check("6: opening it brings the items and the session id back", back.s === session && back.n >= 2, JSON.stringify(back));
  await page.locator("button[aria-label='Settings']").click();
  const sess = await page.evaluate(() => document.querySelector(".chat")?.textContent.match(/Session: (\S+)/)?.[1] ?? "");
  check("6: the settings show the restored session", sess.startsWith(session.slice(0, 8)), sess);
  await page.locator("button[aria-label='Settings']").click();
  // The restored conversation resumes: one more message works in that session.
  await say("one more thing");
  check("6: a message after opening resumes the session", (await page.evaluate(() => window.__dt.chat().sessionId)) === session);
  // Archive it again, then reload: the list is kept.
  await page.locator("button[aria-label='New conversation']").click();
  await sleep(500);
  await page.reload();
  await page.waitForSelector("#dt-canvas", { timeout: 30000 });
  await page.keyboard.press("Control+/");
  await page.waitForSelector(".chat");
  await sleep(500);
  list = await past();
  check("6: after a reload the list is kept", list.length === 1 && list[0] === "make a card", JSON.stringify(list));
  // Delete asks first.
  await page.locator(".past-menu .past-del").first().click();
  await page.waitForSelector(".confirm-dialog");
  await page.locator(".confirm-dialog button:has-text('Cancel')").click();
  list = await past();
  check("6: Cancel keeps it", list.length === 1);
  await page.locator(".past-menu .past-del").first().click();
  await page.waitForSelector(".confirm-dialog");
  await page.locator(".confirm-dialog button.primary").click();
  await sleep(400);
  list = await past();
  check("6: deleting with confirmation removes it", list.length === 0, JSON.stringify(list));
  const empty = await page.evaluate(() => document.querySelector(".past-menu")?.textContent ?? "");
  check("6: an empty list says so", /No past conversations/.test(empty), empty);
  await page.keyboard.press("Escape");
  // Deleting the file clears the history too.
  await say("make a button");
  await page.locator("button[aria-label='New conversation']").click();
  await sleep(500);
  const keysFor = () =>
    page.evaluate(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open("keyval-store");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const keys = await new Promise((res) => {
        const r = db.transaction("keyval").objectStore("keyval").getAllKeys();
        r.onsuccess = () => res(r.result);
      });
      db.close();
      return keys.filter((k) => typeof k === "string" && k.startsWith("dt:chat"));
    });
  const before = await keysFor();
  check("6: the file has a history record", before.some((k) => k.startsWith("dt:chats:")), JSON.stringify(before));
  await page.evaluate(() => (location.hash = "#/"));
  await page.waitForSelector(".files");
  await sleep(500);
  await page.locator("[aria-label^='More actions for']").first().click();
  await page.locator(".menu .item", { hasText: "Delete" }).click();
  await page.locator(".confirm-dialog button.primary").click();
  await sleep(1000);
  const after = await keysFor();
  check("6: deleting the file removes dt:chat:<id> and dt:chats:<id>", after.length === 0, JSON.stringify(after));
  await ctx.close();
}

// ---------------------------------------------------------------- 7. shortcuts
{
  const { ctx, page } = await open();
  await newFile(page);
  const title = await page.locator(".topbar .tbtn[title^='Present (']").getAttribute("title");
  check("7: the Present button's title has the shortcut", /^Present \((Ctrl\+Alt\+|⌥⌘)Enter\)$/.test(title ?? ""), title);
  await page.locator(".topbar [title='Main menu']").click();
  await page.locator(".menu .item", { hasText: "Keyboard shortcuts" }).click();
  await page.waitForSelector(".shortcuts-dialog");
  const rows = await page.evaluate(() => [...document.querySelectorAll(".shortcut-row")].map((r) => r.textContent));
  check("7: the sheet lists Present from the selected frame", rows.some((r) => /Present from the selected frame/.test(r) && /Enter/.test(r)), rows.find((r) => /Present/.test(r)));
  await ctx.close();
}

// ---------------------------------------------------------------- 8. file name from the prompt
{
  const { ctx, page } = await open();
  const prompt = "A habit tracker mobile app, 3 screens";
  await page.locator("textarea[aria-label='What do you want to design?']").fill(prompt);
  await page.locator("textarea[aria-label='What do you want to design?']").press("Enter");
  await page.waitForSelector("#dt-canvas", { timeout: 30000 });
  await sleep(500);
  const name = await page.evaluate(() => window.__dt.doc().name);
  check("8: the file is named after the prompt", name === prompt && name.length <= 40, name);
  await page.evaluate(() => (location.hash = "#/"));
  await page.waitForSelector(".files");
  await sleep(500);
  check("8: the dashboard lists it under that name", (await page.locator(`[aria-label='More actions for ${prompt}']`).count()) >= 1);
  const long = "Design a long-winded onboarding experience for a meditation and sleep tracking app with a paywall";
  await page.locator("textarea[aria-label='What do you want to design?']").fill(long);
  await page.locator("textarea[aria-label='What do you want to design?']").press("Enter");
  await page.waitForSelector("#dt-canvas", { timeout: 30000 });
  await sleep(500);
  const name2 = await page.evaluate(() => window.__dt.doc().name);
  check("8: a long prompt is cut at a word, within 40 characters", name2.length <= 40 && name2.endsWith("…") && long.startsWith(name2.slice(0, -1)), name2);
  await ctx.close();
}

// ---------------------------------------------------------------- 9. Help menu
{
  const { ctx, page } = await open({ perms: true });
  await newFile(page);
  await addRect(page);
  await page.locator(".topbar [title='Main menu']").click();
  await page.waitForSelector(".menu");
  const labels = await page.evaluate(() => [...document.querySelectorAll(".menu .item")].map((e) => e.textContent));
  const want = ["Keyboard shortcuts", "Show tips again", "Help and documentation", "Send feedback…", "About Designotron"];
  check("9: the menu has the five Help items", want.every((w) => labels.some((l) => l.startsWith(w))), JSON.stringify(labels.slice(-7)));
  await page.evaluate(() => document.querySelector(".menu").scrollTo(0, 99999));
  await shot(page, "help-menu");
  // The help page opens in a new tab and loads nothing from outside.
  const popup = ctx.waitForEvent("page");
  await page.locator(".menu .item", { hasText: "Help and documentation" }).click();
  const help = await popup;
  await help.waitForLoadState("load");
  const helpUrl = help.url();
  check("9: Help and documentation opens the bundled page", /\/help\/index\.html$/.test(helpUrl), helpUrl);
  const title = await help.title();
  check("9: the help page loaded", /Designotron help/.test(title), title);
  await help.screenshot({ path: `${OUT}/help-page.png` });
  const status = await page.evaluate(async () => (await fetch("/help/")).status);
  check("9: /help/ answers 200", status === 200, String(status));
  const fromHelp = asked.filter((a) => /\/help\//.test(a.from) || /\/help\//.test(a.u));
  const outside = fromHelp.filter((a) => !LOCAL.test(a.u));
  check("9: the help page made requests, and none left this computer", fromHelp.length >= 1 && outside.length === 0, `${fromHelp.length} from the help page; outside: ${outside.map((a) => a.u).join(", ")}`);
  const refs = await help.evaluate(() => [...document.querySelectorAll("[src],[href]")].map((e) => e.getAttribute("src") ?? e.getAttribute("href")).filter((u) => /^(https?:)?\/\//.test(u) && !u.startsWith(location.origin)));
  check("9: the help page's own markup links only to this site, except the text of commands", refs.length === 0, refs.join(", "));
  await help.close();
  // Feedback.
  await page.locator(".topbar [title='Main menu']").click();
  await page.locator(".menu .item", { hasText: "Send feedback" }).click();
  await page.waitForSelector(".help-dialog");
  await page.locator(".help-dialog textarea").fill("The thing did the other thing");
  await page.locator(".help-dialog button:has-text('Copy details')").click();
  await sleep(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check("9: Copy details puts the message and the details on the clipboard", /The thing did the other thing/.test(clip) && /Designotron \d+\.\d+\.\d+ \(model revision 4\)/.test(clip) && /Layers in this file: \d+/.test(clip), clip.slice(0, 200));
  check("9: the details carry no layer or file content", !/rectangle/i.test(clip));
  const addr = await page.evaluate(() => document.querySelector(".help-dialog .copy-line code")?.textContent ?? "");
  check("9: the issues address is shown as text", /^https:\/\/github\.com\/[^ ]+\/issues$/.test(addr), addr);
  await shot(page, "feedback-dialog");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".help-dialog", { state: "detached" });
  // About.
  await page.locator(".topbar [title='Main menu']").click();
  await page.locator(".menu .item", { hasText: "About Designotron" }).click();
  await page.waitForSelector(".help-dialog");
  const about = await page.locator(".help-dialog").innerText();
  check("9: About shows version, model revision and licence", /\d+\.\d+\.\d+/.test(about) && /\b4\b/.test(about) && /MIT/.test(about), about.replace(/\n/g, " | ").slice(0, 200));
  await page.keyboard.press("Escape");
  // Show tips again: the tour was finished in this profile; the hint comes back.
  check("9: before: no hint", (await page.locator(".hint-card").count()) === 0);
  await page.locator(".topbar [title='Main menu']").click();
  await page.locator(".menu .item", { hasText: "Show tips again" }).click();
  await page.waitForSelector(".hint-card", { timeout: 6000 });
  const hint = await page.locator(".hint-card").innerText();
  check("9: Show tips again brings the layers hint back", /Layers/.test(hint), hint.slice(0, 60));
  await ctx.close();
}

// ---------------------------------------------------------------- 10. quick actions say why they are disabled
{
  const { ctx, page } = await open();
  await newFile(page);
  await page.keyboard.press("Control+/");
  await page.waitForSelector(".chat");
  await page.locator("button[aria-label='Quick actions']").click();
  await page.waitForSelector(".menu");
  const items = await page.evaluate(() =>
    [...document.querySelectorAll(".menu .item")].map((e) => ({ text: e.textContent, disabled: e.disabled, title: e.title, desc: e.getAttribute("aria-description") })),
  );
  const sel = items.find((i) => i.text.startsWith("Make variants of the selection"));
  check("10: a selection action says 'Select layers first'", !!sel && sel.disabled && /Select layers first/.test(sel.text) && sel.title === "Select layers first" && sel.desc === "Select layers first", JSON.stringify(sel));
  const img = items.find((i) => i.text.startsWith("Rebuild attached screenshot"));
  check("10: the screenshot action says to attach one", !!img && img.disabled && /Attach a screenshot first/.test(img.text), JSON.stringify(img));
  const content = items.find((i) => i.text.startsWith("Rename layers semantically"));
  check("10: a page action says to add something first", !!content && content.disabled && /Add something to this page first/.test(content.text), JSON.stringify(content));
  const free = items.find((i) => i.text.startsWith("Import screens from my codebase"));
  check("10: an available action has no hint", !!free && !free.disabled && free.title === "", JSON.stringify(free));
  await shot(page, "quick-actions-reasons");
  await page.keyboard.press("Escape");
  await ctx.close();
}

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
