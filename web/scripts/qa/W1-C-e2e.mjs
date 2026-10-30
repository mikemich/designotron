// Collaboration and history correctness (W1-C), in two browsers against a relay that serves
// the built editor: undo/redo never overwrites a collaborator's newer value, offline editors
// say so and catch up, relay pages make no failing requests, share links say where they open,
// and redo of "Add page" brings the new page back as the current one.
//   cargo run -p designotron-relay -- --port 8787 --static web/dist
//   E2E_RELAY=http://127.0.0.1:8787 node scripts/qa/W1-C-e2e.mjs

import { chromium } from "playwright-core";
import fs from "node:fs";

const RELAY = process.env.E2E_RELAY ?? "http://127.0.0.1:8787";
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const init = (name) => () => {
  try {
    localStorage.setItem("dt:tour-done", "1");
    localStorage.setItem("dt:userName", name);
  } catch {
    /* sandboxed frames */
  }
};

const browser = await chromium.launch(launch);
const newPage = async (name, { editorUrl } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  p.on("response", (r) => r.status() >= 400 && p.errors.push(`HTTP ${r.status()} ${r.url()}`));
  await p.addInitScript(init(name));
  if (editorUrl) await p.addInitScript((u) => localStorage.setItem("dt:editorUrl", u), editorUrl);
  return p;
};
const fill = (c) => [{ type: "solid", color: c, opacity: 1, visible: true }];
const colour = (p, id) => p.evaluate((id) => window.__dt.doc().nodes[id].fills[0].color, id);
const upd = (p, ids, patch) => p.evaluate(([ids, patch]) => window.__dt.dispatch({ op: "update", ids, patch }), [ids, patch]);
const waitFor = (p, fn, arg) => p.waitForFunction(fn, arg, { timeout: 8000 }).then(() => true, () => false);

try {
  // No failing request when a relay serves the editor (it used to probe /bridge/status, a 404).
  const owner = await newPage("Olga");
  await owner.goto(RELAY);
  await owner.click("button:has-text('New design file')");
  await owner.waitForSelector("#dt-canvas");
  await sleep(1500);
  check("no failing request on a relay page", !owner.errors.some((e) => e.startsWith("HTTP 4") || e.startsWith("HTTP 5")), owner.errors.join(" | "));

  // Redo of Add page restores the page as the current one.
  const cur = () => owner.evaluate(() => window.__dt.doc().pages.find((p) => p.id === window.__dt.state().page)?.name);
  await owner.click("button[title='Add page']");
  await sleep(150);
  const added = await cur();
  await owner.keyboard.press("Control+z");
  await sleep(150);
  const afterUndo = await cur();
  await owner.keyboard.press("Control+Shift+z");
  await sleep(150);
  check("redo of Add page makes the new page current", added === "Page 2" && afterUndo === "Page 1" && (await cur()) === "Page 2", `${added} / ${afterUndo} / ${await cur()}`);

  const rect = await owner.evaluate(() => window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "rectangle", name: "Box", x: 0, y: 0, width: 120, height: 80, fill: "#D9D9D9" }] } }).created[0].id);

  // Share online; Ann joins.
  await owner.click(".tbtn[title='Share for live editing']");
  if (!(await owner.locator(".share-dialog input.mono").count())) await owner.click("text=Use a different relay");
  await owner.fill(".share-dialog input.mono", RELAY);
  await owner.click("button:has-text('Share online')");
  await owner.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 10000 });
  const link = await owner.evaluate(() => window.__dt.collab().link);
  await owner.keyboard.press("Escape");
  const ann = await newPage("Ann");
  await ann.goto(link);
  await ann.waitForFunction((id) => window.__dt.collab().status === "live" && !!window.__dt.doc().nodes[id], rect, { timeout: 15000 });

  // A collaborator's newer value of the same property survives my undo and redo.
  await upd(owner, [rect], { fills: fill("#FF0000") });
  await waitFor(ann, (id) => window.__dt.doc().nodes[id].fills[0].color === "#FF0000", rect);
  await upd(ann, [rect], { fills: fill("#0000FF"), x: 90 });
  await waitFor(owner, (id) => window.__dt.doc().nodes[id].fills[0].color === "#0000FF", rect);
  await owner.evaluate(() => window.__dt.dispatch({ op: "undo" }));
  await sleep(600);
  check("owner's undo keeps Ann's newer fill", (await colour(owner, rect)) === "#0000FF" && (await colour(ann, rect)) === "#0000FF", `${await colour(owner, rect)} / ${await colour(ann, rect)}`);
  await owner.evaluate(() => window.__dt.dispatch({ op: "redo" }));
  await sleep(600);
  check("owner's redo keeps Ann's newer fill", (await colour(owner, rect)) === "#0000FF" && (await colour(ann, rect)) === "#0000FF", `${await colour(owner, rect)} / ${await colour(ann, rect)}`);
  check("...and her other edit", (await owner.evaluate((id) => window.__dt.doc().nodes[id].x, rect)) === 90);

  // Undo of a style edit leaves a style the other person added.
  await owner.evaluate(() => window.__dt.dispatch({ op: "addColorStyle", name: "Mine", color: "#111111" }));
  await sleep(500);
  const mine = await owner.evaluate(() => window.__dt.doc().styles.colors[0].id);
  await owner.evaluate((id) => window.__dt.dispatch({ op: "updateColorStyle", id, color: "#222222" }), mine);
  await sleep(500);
  await ann.evaluate(() => window.__dt.dispatch({ op: "addColorStyle", name: "Hers", color: "#333333" }));
  await waitFor(owner, () => window.__dt.doc().styles.colors.length === 2);
  await owner.evaluate(() => window.__dt.dispatch({ op: "undo" }));
  await sleep(600);
  const names = (p) => p.evaluate(() => window.__dt.doc().styles.colors.map((s) => s.name + ":" + s.color).sort().join(","));
  check("undo of a style edit keeps the style Ann added", (await names(owner)) === "Hers:#333333,Mine:#111111" && (await names(ann)) === (await names(owner)), `${await names(owner)} / ${await names(ann)}`);

  // Offline: the editor says so at once, keeps edits, and catches up when the network is back.
  await ann.context().setOffline(true);
  const offline = await waitFor(ann, () => window.__dt.collab().status !== "live");
  check("going offline shows reconnecting", offline && (await ann.locator(".reconnecting").count()) === 1);
  const offEdit = await ann.evaluate(() => window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "ellipse", name: "Offline dot", x: 300, y: 0, width: 40, height: 40 }] } }).created[0].id);
  await upd(owner, [rect], { opacity: 0.5 });
  await ann.context().setOffline(false);
  check("back online, the editor goes live again", await waitFor(ann, () => window.__dt.collab().status === "live"));
  const caught = await waitFor(owner, (id) => !!window.__dt.doc().nodes[id], offEdit);
  const opacity = await waitFor(ann, (id) => window.__dt.doc().nodes[id].opacity === 0.5, rect);
  check("edits made offline reach the room, and the room's reach the editor", caught && opacity);

  // Share links say where they open, and the override redirects them.
  const share = await newPage("Sam");
  await share.goto(RELAY);
  await share.click("button:has-text('New design file')");
  await share.waitForSelector("#dt-canvas");
  await share.click(".tbtn[title='Share for live editing']");
  const note = await share.locator(".share-destination").first().innerText();
  check("share dialog names the hosted editor", /mikemich\.github\.io\/designotron/.test(note) && /Preview here/.test(note), note);
  const [preview] = await Promise.all([share.context().waitForEvent("page", { timeout: 8000 }), share.click(".share-destination .link-btn:has-text('Preview here')")]);
  await preview.waitForURL(/#\/(copy|file)\//, { timeout: 8000 }).catch(() => {});
  check("Preview here opens the link on this editor", preview.url().startsWith(RELAY + "/#/"), preview.url().slice(0, 60));
  await preview.close();

  const mine2 = await newPage("Kim", { editorUrl: RELAY });
  await mine2.goto(RELAY);
  await mine2.click("button:has-text('New design file')");
  await mine2.waitForSelector("#dt-canvas");
  await mine2.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: RELAY });
  await mine2.click(".tbtn[title='Share for live editing']");
  await mine2.click("button:has-text('Copy link')");
  await sleep(600);
  const copied = await mine2.evaluate(() => navigator.clipboard.readText());
  check("dt:editorUrl redirects copy links", copied.startsWith(RELAY + "/#/copy/"), copied.slice(0, 50));
  await mine2.keyboard.press("Escape");
  // An "online" event while a reconnect is still opening must not leave two sockets joined.
  const shareRoom = async (p) => {
    await p.goto(RELAY);
    await p.click("button:has-text('New design file')");
    await p.waitForSelector("#dt-canvas");
    await p.click(".tbtn[title='Share for live editing']");
    if (!(await p.locator(".share-dialog input.mono").count())) await p.click("text=Use a different relay");
    await p.fill(".share-dialog input.mono", RELAY);
    await p.click("button:has-text('Share online')");
    await p.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 10000 });
    const link = await p.evaluate(() => window.__dt.collab().link);
    await p.keyboard.press("Escape");
    return link;
  };
  const race = await newPage("Rae");
  await race.addInitScript(() => {
    window.__open = 0;
    window.__joins = 0;
    window.__race = false;
    const Orig = WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) {
        super(...a);
        if (!String(a[0]).includes("/ws?room")) return;
        this.addEventListener("open", () => window.__open++);
        this.addEventListener("close", () => window.__open--);
        const send = this.send.bind(this);
        this.send = (d) => {
          if (String(d).includes('"type":"join"')) window.__joins++;
          send(d);
        };
        if (window.__race) {
          window.__race = false;
          queueMicrotask(() => dispatchEvent(new Event("online")));
        }
      }
    };
  });
  const raceLink = await shareRoom(race);
  const gus = await newPage("Gus");
  await gus.goto(raceLink);
  await gus.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 15000 });
  await race.evaluate(() => {
    window.__race = true;
    dispatchEvent(new Event("offline"));
  });
  await sleep(6000);
  const rs = await race.evaluate(() => ({ open: window.__open, joins: window.__joins, status: window.__dt.collab().status }));
  const seen = await gus.evaluate(() => Object.values(window.__dt.collab().peers).map((x) => x.name));
  check("an online event during a reconnect opens no second socket", rs.open === 1 && rs.joins === 2 && rs.status === "live" && seen.length === 1, JSON.stringify({ ...rs, seen }));

  // Timers in hidden tabs can run a minute late. Late ticks alone must not drop the connection
  // (peers would see the person leave and the whole file would be sent again).
  const slow = await newPage("Sloane");
  await slow.addInitScript(() => {
    window.__sockets = 0;
    window.__throttle = false;
    const Orig = WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) {
        super(...a);
        if (String(a[0]).includes("/ws?room")) window.__sockets++;
      }
    };
    const si = window.setInterval;
    window.setInterval = (f, ms, ...a) => {
      let last = Date.now();
      return si(() => {
        if (window.__throttle && Date.now() - last < 60000) return;
        last = Date.now();
        f();
      }, ms, ...a);
    };
  });
  await shareRoom(slow);
  await sleep(12000); // the room has answered pings: late ticks are now the only difference
  await slow.evaluate(() => (window.__throttle = true));
  await sleep(75000);
  const ss = await slow.evaluate(() => ({ sockets: window.__sockets, status: window.__dt.collab().status }));
  check("hidden-tab timer lateness does not reconnect", ss.sockets === 1 && ss.status === "live", JSON.stringify(ss));
  // A connection that stays "open" but goes silent (a dropped network) is replaced within ~30 s.
  const dead = await newPage("Dana");
  await dead.addInitScript(() => {
    window.__mute = false;
    window.__sockets = 0;
    const Orig = WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) {
        super(...a);
        if (!String(a[0]).includes("/ws?room")) return;
        window.__sockets++;
        const send = this.send.bind(this);
        this.send = (d) => !window.__mute && send(d);
        const desc = Object.getOwnPropertyDescriptor(Orig.prototype, "onmessage");
        Object.defineProperty(this, "onmessage", {
          set(f) {
            desc.set.call(this, f && ((e) => !window.__mute && f(e)));
          },
          get() {
            return desc.get.call(this);
          },
        });
      }
    };
  });
  await shareRoom(dead);
  await sleep(12000); // at least one pong heard
  await dead.evaluate(() => (window.__mute = true));
  const t0 = Date.now();
  let noticed = 0;
  while (Date.now() - t0 < 45000 && !noticed) {
    await sleep(1000);
    const d = await dead.evaluate(() => ({ st: window.__dt.collab().status, n: window.__sockets }));
    if (d.st !== "live" || d.n > 1) noticed = Date.now() - t0;
  }
  check("a silent connection is noticed within ~40 s", noticed > 0 && noticed < 40000, `${noticed} ms`);
} catch (e) {
  failed++;
  console.log("FAIL  script error:", e.stack ?? e);
} finally {
  await browser.close();
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
