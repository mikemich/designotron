// Wave 3 / W3-B: presence. Follow, spotlight, names on selections, cursor chat, distinct cursor
// colours and view-only live links, against a new relay; and what happens against an old one.
//
//   E2E_URL     the editor (vite or a built dist). Defaults to E2E_RELAY, which serves it when started
//               with --static web/dist.
//   E2E_RELAY   a relay built from this branch: `designotron-relay --port <p> --static web/dist`.
//   E2E_OLD_RELAY   (optional) a relay built from 17065fb; runs section C, else C prints SKIP.
//   E2E_OLD_EDITOR  (optional) the web/dist of 17065fb served somewhere; runs section D, else SKIP.
//
// How to get the old relay and old editor:
//   git worktree add <scratch>/old 17065fb && cd <scratch>/old
//   CARGO_TARGET_DIR=<scratch>/target-old cargo build -p designotron-relay
//   ln -s /home/user/designotron/web/node_modules web/node_modules && (cd web && npm run build)
//   <scratch>/target-old/debug/designotron-relay --port 5515 --static <scratch>/old/web/dist
//   (the same old dist can be served on another port by a second old relay for E2E_OLD_EDITOR)
//
// Nothing leaves this machine: every request outside 127.0.0.1 / localhost is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";

const RELAY = (process.env.E2E_RELAY ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const EDITOR = (process.env.E2E_URL ?? RELAY).replace(/\/+$/, "");
const OLD_RELAY = (process.env.E2E_OLD_RELAY ?? "").replace(/\/+$/, "");
const OLD_EDITOR = (process.env.E2E_OLD_EDITOR ?? "").replace(/\/+$/, "");
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (u) => /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(u) || /^(data|blob|about):/.test(u);

/** Sections to run: E2E_ONLY=C runs just C (A includes B). */
const ONLY = process.env.E2E_ONLY ?? "ABCD";
const browser = await chromium.launch(launch);
const contexts = [];
/** A page with a name, pointed at `relay`, with nothing allowed off this machine. `opts.random` fixes Math.random. */
const newPage = async (name, { relay = RELAY, editor = EDITOR, random } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  contexts.push(ctx);
  await ctx.route("**/*", (route) => (local(route.request().url()) ? route.continue() : route.abort()));
  const p = await ctx.newPage();
  p.errors = [];
  p.frames = [];
  p.sockets = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  p.on("websocket", (ws) => {
    p.sockets.push(ws.url());
    ws.on("framereceived", (f) => p.frames.push(String(f.payload)));
  });
  await p.addInitScript(
    ([n, relayUrl, editorUrl, rnd]) => {
      try {
        localStorage.setItem("dt:tour-done", "1");
        localStorage.setItem("dt:userName", n);
        localStorage.setItem("dt:relay", relayUrl);
        localStorage.setItem("dt:editorUrl", editorUrl + "/");
      } catch {
        /* sandboxed */
      }
      if (rnd !== null) Math.random = () => rnd;
    },
    [name, relay, editor, random ?? null],
  );
  return p;
};
const dispatch = (p, cmd) => p.evaluate((c) => window.__dt.dispatch(c), cmd);
const waitFor = (p, fn, arg, timeout = 10000) => p.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const live = (p) => waitFor(p, () => window.__dt.collab().status === "live", null, 15000);
const nodes = (p) => p.evaluate(() => window.__dt.doc().nodes);
/** Centre of what the canvas shows, in page coordinates, and the zoom. */
const centre = (p) =>
  p.evaluate(() => {
    const v = window.__dt.viewport();
    const el = document.getElementById("dt-canvas");
    return { x: (el.clientWidth / 2 - v.x) / v.zoom, y: (el.clientHeight / 2 - v.y) / v.zoom, zoom: v.zoom, w: el.clientWidth / v.zoom };
  });
const near = async (a, b) => {
  const [ca, cb] = [await centre(a), await centre(b)];
  return Math.abs(ca.x - cb.x) < 0.05 * ca.w && Math.abs(ca.y - cb.y) < 0.05 * ca.w && Math.abs(ca.zoom / cb.zoom - 1) < 0.05;
};
const waitNear = async (a, b, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await near(a, b)) return true;
    await sleep(150);
  }
  return false;
};
const text = (p, sel) => p.locator(sel).first().textContent({ timeout: 1500 }).then((t) => t ?? "", () => "");
const count = (p, sel) => p.locator(sel).count();

/** Owner: new file with two boxes on page 1 and an empty page 2, shared online. Returns ids and the link. */
async function startRoom(owner) {
  await owner.goto(EDITOR + "/");
  await owner.click("button:has-text('New design file')");
  await owner.waitForSelector("#dt-canvas");
  const made = await dispatch(owner, {
    op: "ai",
    tool: "create_nodes",
    input: { nodes: [
      { type: "rectangle", name: "Box A", x: 0, y: 0, width: 200, height: 120, fill: "#6D4AFF" },
      { type: "rectangle", name: "Box B", x: 2400, y: 1600, width: 200, height: 120, fill: "#0FA958" },
    ] },
  });
  const [a, b] = made.created.map((c) => c.id);
  const page1 = await owner.evaluate(() => window.__dt.state().page);
  await dispatch(owner, { op: "addPage" });
  const page2 = await owner.evaluate(() => window.__dt.state().page);
  await dispatch(owner, { op: "setPage", id: page1 });
  await owner.evaluate(() => window.__dt.zoomToFit());
  await owner.click(".tbtn[title='Share for live editing']");
  await owner.waitForSelector(".share-dialog");
  await owner.click("button:has-text('Share online')");
  const ok = await live(owner);
  const link = await owner.evaluate(() => window.__dt.collab().link);
  return { ok, link, a, b, page1, page2 };
}

if (ONLY.includes("A")) try {
  // ---- A. New relay: owner, guest and viewer -------------------------------------------------
  const owner = await newPage("Olga");
  const room = await startRoom(owner);
  check("A0 owner shares online", room.ok && /[?&]room=/.test(room.link), room.link);
  const roomId = new URL(room.link).searchParams.get("room");

  // 7. The Share dialog offers both links; the view link opens as a viewer.
  await owner.waitForSelector(".share-dialog #share-link");
  const editLink = await owner.inputValue("#share-link");
  await owner.waitForSelector("#share-view-link", { timeout: 5000 }).catch(() => {});
  const viewLink = (await count(owner, "#share-view-link")) ? await owner.inputValue("#share-view-link") : "";
  check("A7 the Share dialog shows 'Can edit' and 'Can view' links", editLink.includes("room=") && /[?&]view=[0-9a-f]{32}/.test(viewLink) && !viewLink.includes(roomId), viewLink);
  await owner.keyboard.press("Escape");

  const guest = await newPage("Gina");
  await guest.goto(editLink);
  check("A0 guest joins", await live(guest) && (await waitFor(guest, (id) => !!window.__dt.doc().nodes[id], room.a)));

  const viewer = await newPage("Vera");
  await viewer.goto(viewLink);
  check("A7 the view link opens as a viewer", (await live(viewer)) && (await waitFor(viewer, () => window.__dt.collab().viewer === true && window.__dt.state().readOnly === true)), viewLink.slice(0, 80));
  await waitFor(viewer, (id) => !!window.__dt.doc().nodes[id], room.a);
  await waitFor(owner, () => Object.keys(window.__dt.collab().peers).length === 2);

  // 1. Follow: click the owner's avatar; the guest's view tracks the owner's.
  await owner.mouse.move(700, 500);
  await guest.click(".peer-avatars button.avatar >> nth=0");
  await sleep(300);
  await owner.evaluate(() => window.__dt.setViewport({ x: -300, y: -200, zoom: 0.5 }));
  check("A1 the guest's view follows the owner's pan (within 5%)", await waitNear(owner, guest));
  await owner.evaluate(() => window.__dt.setViewport({ x: -900, y: -600, zoom: 0.25 }));
  check("A1 ...and the owner's zoom", await waitNear(owner, guest));
  const bar = await text(guest, ".follow-bar");
  check("A1 the follow bar names the owner and offers Stop following", /Following Olga/.test(bar) && /Stop following/.test(bar), bar.replace(/\n/g, " "));
  check("A1 the canvas has a border in their colour", (await count(guest, ".follow-frame")) === 1);
  await guest.mouse.move(700, 500);
  await guest.keyboard.down("Control");
  await guest.mouse.wheel(0, -240);
  await guest.keyboard.up("Control");
  await sleep(300);
  check("A1 wheel-zooming ends following (bar and border gone)", (await count(guest, ".follow-bar")) === 0 && (await count(guest, ".follow-frame")) === 0);

  // 2. Following switches page.
  await guest.click(".peer-avatars button.avatar >> nth=0");
  await owner.evaluate((id) => window.__dt.dispatch({ op: "setPage", id }), room.page2);
  check("A2 the following guest switches page with the owner", await waitFor(guest, (id) => window.__dt.state().page === id, room.page2, 6000));
  await owner.evaluate((id) => window.__dt.dispatch({ op: "setPage", id }), room.page1);
  check("A2 ...and back", await waitFor(guest, (id) => window.__dt.state().page === id, room.page1, 6000));
  const tip = await guest.getAttribute(".peer-avatars button.avatar >> nth=0", "title");
  check("A2 an avatar's tooltip names the person and their page", /Olga/.test(tip ?? "") && /Page 1/.test(tip ?? ""), tip);
  await guest.click(".follow-bar button:has-text('Stop following')");
  check("A1 Stop following works", (await count(guest, ".follow-bar")) === 0);
  // Pressing Escape with nothing else to close also stops it.
  await guest.click(".peer-avatars button.avatar >> nth=0");
  await guest.evaluate(() => document.getElementById("dt-canvas").focus());
  await guest.keyboard.press("Escape");
  check("A1 Escape (nothing else to close) stops following", (await count(guest, ".follow-bar")) === 0);

  // 3. Spotlight.
  await owner.click("button[data-me]");
  await owner.click(".menu [role=menuitem]:has-text('Spotlight me')");
  const sawBar = async (p) => waitFor(p, () => /is spotlighting/.test(document.querySelector(".follow-bar")?.textContent ?? ""), null, 3000);
  check("A3 viewer and guest see 'Olga is spotlighting' with Not now", (await sawBar(guest)) && (await sawBar(viewer)) && /Not now/.test(await text(guest, ".follow-bar")));
  const followed = async (p) => waitFor(p, () => /Following Olga/.test(document.querySelector(".follow-bar")?.textContent ?? ""), null, 4500);
  check("A3 ...then both follow within 4 s", (await followed(guest)) && (await followed(viewer)));
  await sleep(300);
  check("A3 the owner's avatar is dashed and shows 2 followers", (await text(owner, "button[data-me] .spot-count")) === "2" && (await owner.locator("button[data-me].spotlighting").count()) === 1);
  check("A3 the owner has a Stop control", (await count(owner, ".follow-bar.mine button:has-text('Stop')")) === 1);
  await guest.click(".follow-bar button:has-text('Stop following')");
  await sleep(400);
  check("A3 after the guest stops, the owner shows 1", (await text(owner, "button[data-me] .spot-count")) === "1");
  check("A3 the guest's bar offers Follow", (await guest.getByRole("button", { name: "Follow", exact: true }).count()) === 1);
  await guest.getByRole("button", { name: "Follow", exact: true }).click();
  check("A3 ...and Follow rejoins", await followed(guest));
  await owner.click(".follow-bar.mine button:has-text('Stop')");
  await sleep(500);
  check("A3 ending the spotlight ends the follow that came from it", (await count(guest, ".follow-bar")) === 0 && (await count(viewer, ".follow-bar")) === 0);
  // "Not now" is honoured.
  await owner.click("button[data-me]");
  await owner.click(".menu [role=menuitem]:has-text('Spotlight me')");
  await sawBar(guest);
  await guest.click(".follow-bar button:has-text('Not now')");
  await sleep(3600);
  check("A3 Not now keeps the guest from following", (await count(guest, ".follow-bar:has-text('Following')")) === 0);
  await owner.click(".follow-bar.mine button:has-text('Stop')");
  await viewer.click(".follow-bar button:has-text('Stop following')").catch(() => {});

  // Following each other is refused (it would chase one view round and round).
  await guest.click(".peer-avatars button.avatar >> nth=0");
  await sleep(500);
  const olgaId = await owner.evaluate(() => window.__dt.collab().me);
  await owner.click(".peer-avatars button.avatar:has-text('G')");
  await sleep(400);
  check("A3b following someone who follows you is refused with a note", (await count(owner, ".follow-bar:has-text('Following')")) === 0 && /Gina is following you/.test(await text(owner, ".toast")), olgaId + " " + (await text(owner, ".toast")));
  await guest.click(".follow-bar button:has-text('Stop following')");
  await sleep(300);
  // Two spotlights at once: the newer wins, the other one ends.
  await owner.click("button[data-me]");
  await owner.click(".menu [role=menuitem]:has-text('Spotlight me')");
  await sleep(700);
  await guest.click("button[data-me]");
  await guest.click(".menu [role=menuitem]:has-text('Spotlight me')");
  await sleep(1500);
  check("A3b with two spotlights the newer one wins and the older one ends", (await count(guest, ".follow-bar.mine")) === 1 && (await count(owner, ".follow-bar.mine")) === 0);
  await sleep(3800);
  check("A3b ...the others follow the winner and nobody's view collapses", /Following Gina/.test(await text(owner, ".follow-bar")) && (await owner.evaluate(() => window.__dt.viewport().zoom)) > 0.05 && (await guest.evaluate(() => window.__dt.viewport().zoom)) > 0.05 && (await viewer.evaluate(() => window.__dt.viewport().zoom)) > 0.05);
  await guest.click(".follow-bar.mine button:has-text('Stop')");
  await sleep(600);
  check("A3b ending the winning spotlight ends those follows", (await count(owner, ".follow-bar")) === 0 && (await count(viewer, ".follow-bar")) === 0);

  // 4. Names on selections.
  await guest.evaluate(() => window.__dt.zoomToFit());
  await owner.evaluate(() => window.__dt.zoomToFit());
  await dispatch(guest, { op: "select", ids: [room.a] });
  await owner.waitForSelector(".remote-tag", { timeout: 5000 }).catch(() => {});
  const tag = await owner.locator(".remote-tag").first().boundingBox().catch(() => null);
  const outline = await owner.locator("svg.overlay polygon[fill=none]").first().boundingBox().catch(() => null);
  check("A4 the owner sees a 'Gina' tag at the guest's selection", (await text(owner, ".remote-tag")) === "Gina" && !!tag && !!outline && Math.abs(tag.x - outline.x) < 10 && Math.abs(tag.y + tag.height - outline.y) < 10, JSON.stringify({ tag, outline }));
  await dispatch(guest, { op: "select", ids: [room.a, room.b] });
  await sleep(300);
  check("A4 one tag per person, not per layer", (await count(owner, ".remote-tag")) === 1);
  await dispatch(guest, { op: "select", ids: [] });

  // 5. Cursor chat.
  await owner.mouse.move(600, 400);
  await owner.mouse.move(640, 420);
  await guest.mouse.move(300, 300);
  await owner.evaluate(() => document.getElementById("dt-canvas").focus());
  await owner.keyboard.press("/");
  await owner.waitForSelector(".chat-bubble.mine input", { timeout: 3000 }).catch(() => {});
  await owner.keyboard.type("hello");
  check("A5 the guest sees 'hello' at the owner's cursor", await waitFor(guest, () => [...document.querySelectorAll(".chat-bubble")].some((b) => b.textContent === "hello"), null, 4000));
  check("A5 the viewer sees it too", await waitFor(viewer, () => [...document.querySelectorAll(".chat-bubble")].some((b) => b.textContent === "hello"), null, 4000));
  await owner.keyboard.type("x".repeat(60));
  check("A5 a message holds at most 52 characters", (await owner.inputValue(".chat-bubble.mine input")).length === 52);
  check("A5 typing didn't trigger shortcuts", (await owner.evaluate(() => window.__dt.state().page)) === room.page1 && (await owner.evaluate(() => window.__dt.doc().pages.length)) === 2);
  await owner.keyboard.press("Enter");
  await sleep(300);
  check("A5 Enter starts a new message (the old one clears)", (await owner.inputValue(".chat-bubble.mine input")) === "" && (await count(guest, ".chat-bubble")) === 0);
  await owner.keyboard.type("bye");
  await sleep(6200);
  check("A5 6 s after typing stops the bubble is gone", (await count(guest, ".chat-bubble")) === 0 && (await count(owner, ".chat-bubble")) === 0);
  await owner.evaluate(() => document.getElementById("dt-canvas").focus());
  await owner.keyboard.press("/");
  await owner.keyboard.type("gone");
  await owner.keyboard.press("Escape");
  await sleep(400);
  check("A5 Escape clears the message", (await count(guest, ".chat-bubble")) === 0 && (await count(owner, ".chat-bubble")) === 0);
  await guest.evaluate(() => document.getElementById("dt-canvas").focus());
  const lonely = await newPage("Solo");
  await lonely.goto(EDITOR + "/");
  await lonely.click("button:has-text('New design file')");
  await lonely.waitForSelector("#dt-canvas");
  await lonely.evaluate(() => document.getElementById("dt-canvas").focus());
  await lonely.keyboard.press("/");
  check("A5 / does nothing when nobody else is in the file", (await count(lonely, ".chat-bubble")) === 0);

  // 6. The viewer can look and comment, nothing else.
  const rectBtn = await viewer.locator("button[title^='Rectangle']").first().isVisible().catch(() => false);
  check("A6 the viewer's toolbar has no Rectangle tool", !rectBtn);
  check("A6 ...and says 'View only'", /View only/.test(await text(viewer, ".topbar")));
  check("A6 ...no Claude button, no chat panel", (await viewer.locator("#claude-toggle").isVisible().catch(() => false)) === false);
  const before = Object.keys(await nodes(viewer)).length;
  await viewer.evaluate(() => document.getElementById("dt-canvas").focus());
  await viewer.keyboard.press("r");
  const box = await viewer.locator("#dt-canvas").boundingBox();
  await viewer.mouse.move(box.x + 500, box.y + 300);
  await viewer.mouse.down();
  await viewer.mouse.move(box.x + 650, box.y + 380, { steps: 5 });
  await viewer.mouse.up();
  await sleep(500);
  check("A6 pressing R and dragging creates nothing", Object.keys(await nodes(viewer)).length === before && Object.keys(await nodes(owner)).length === before);
  const refused = await viewer.evaluate((id) => window.__dt.dispatch({ op: "update", ids: [id], patch: { x: 77 } }), room.a);
  const note = await text(viewer, ".toast.error");
  await sleep(400);
  check("A6 a viewer's update is refused with 'You can view this file but not edit it'", refused === null && /view this file but not edit/.test(note), note);
  check("A6 ...and the owner's document is unchanged", (await nodes(owner))[room.a].x === 0 && (await nodes(guest))[room.a].x === 0);
  await dispatch(viewer, { op: "addComment", x: 40, y: 40, text: "Nice from the viewer", author: "Vera", time: Date.now() });
  check("A6 the viewer adds a comment and the owner sees it", await waitFor(owner, () => Object.values(window.__dt.doc().comments).some((c) => c.messages[0].text === "Nice from the viewer")));
  const cid = await owner.evaluate(() => Object.keys(window.__dt.doc().comments)[0]);
  await dispatch(viewer, { op: "resolveComment", id: cid, resolved: true });
  check("A6 ...and can resolve it", await waitFor(owner, (id) => window.__dt.doc().comments[id]?.resolved === true, cid));
  await viewer.click(".tbtn[title='Shared: live']");
  await viewer.waitForSelector(".share-dialog");
  const dialog = await text(viewer, ".share-dialog");
  check("A6 the viewer's Share dialog shows no edit link", (await count(viewer, ".share-dialog input.mono")) === 0 && !dialog.includes(roomId), dialog.slice(0, 60).replace(/\n/g, " "));
  await viewer.keyboard.press("Escape");
  check("A6 the viewer's URL and every frame it received hold no edit room id", !viewer.url().includes(roomId) && viewer.frames.length > 0 && viewer.frames.every((f) => !f.includes(roomId)), `${viewer.frames.length} frames`);
  check("A6 the viewer's document didn't change by itself (no rejected sync)", (await nodes(owner))[room.a].x === 0);
  // A viewer can't end the room: the owner is still sharing.
  check("A6 the room is still open for new editors", await (async () => {
    const late = await newPage("Late");
    await late.goto(editLink);
    return (await live(late)) && (await waitFor(late, (id) => !!window.__dt.doc().nodes[id], room.a));
  })());

  // The copy that keeps a viewer's own file.
  await viewer.click("button:has-text('Make my own copy')");
  await sleep(800);
  check("A6 Make my own copy leaves the room and lifts the restriction", (await viewer.evaluate(() => window.__dt.state().readOnly === false)) && !viewer.url().includes("view="));

  // 8. Hostile presence and comments from a raw view-link socket; the editors stay alive.
  const wsBase = RELAY.replace(/^http/, "ws");
  const raw = new WebSocket(`${wsBase}/ws?view=${new URL(viewLink).searchParams.get("view")}`);
  const rawMsgs = [];
  raw.onmessage = (e) => rawMsgs.push(JSON.parse(e.data));
  await new Promise((r) => (raw.onopen = r));
  raw.send(JSON.stringify({ type: "join", name: "Raw", color: "url(http://127.0.0.1:1/leak)" }));
  await sleep(500);
  const pageNow = await owner.evaluate(() => window.__dt.state().page);
  const bad = [
    { page: pageNow, cursor: { x: 10, y: 10 }, selection: [], chat: { text: { evil: 1 }, t: 1 } },
    { page: pageNow, cursor: { x: 10, y: 10 }, selection: 5 },
    { page: pageNow, cursor: { x: 10, y: 10 }, selection: [], chat: { text: "x".repeat(15000), t: 2 }, color: "url(http://127.0.0.1:1/leak)" },
    { page: pageNow, cursor: { x: 10, y: 10 }, selection: [], view: { x: -1e308, y: 0, w: 1e308, h: 1e-300 }, spotlight: Date.now() },
    { page: pageNow, cursor: { x: "a", y: null }, selection: [1, 2, null], following: "x", color: 7 },
  ];
  for (const presence of bad) {
    raw.send(JSON.stringify({ type: "presence", presence }));
    await sleep(80);
  }
  await sleep(500);
  const seenRaw = await owner.evaluate(() => Object.values(window.__dt.collab().peers).find((p) => p.name === "Raw") ?? null);
  const vp = await owner.evaluate(() => window.__dt.viewport());
  check("A8 hostile presence doesn't crash the editors or fetch URLs", owner.errors.length === 0 && guest.errors.length === 0 && (await owner.locator("#dt-canvas").count()) === 1 && !!seenRaw && /^#[0-9a-f]{6}$/i.test(seenRaw.color) && Number.isFinite(vp.zoom) && vp.zoom > 0.01, `${JSON.stringify(seenRaw?.presence)?.slice(0, 160)} ${owner.errors.join("|")}`);
  check("A8 chat text is bounded", !seenRaw?.presence?.chat || (typeof seenRaw.presence.chat.text === "string" && seenRaw.presence.chat.text.length <= 52));
  await sleep(4000);
  check("A8 a stray spotlight from a peer with a nonsense view doesn't zoom the owner out", (await owner.evaluate(() => window.__dt.viewport().zoom)) > 0.01 && (await guest.evaluate(() => window.__dt.viewport().zoom)) > 0.01);
  const pagesBefore = await owner.evaluate(() => window.__dt.doc().pages.length);
  const attack = { id: "cx", page: pageNow, x: 1, y: 2, node: null, resolved: false, messages: [{ author: "R", text: "hi", time: 1 }] };
  const sent = [{ comments: { cx: attack }, pages: [] }, { comments: { cx: attack }, pages: null }, { comments: { cx: attack }, styles: {} }, { comments: { cx: attack }, variables: [] }];
  for (const delta of sent) raw.send(JSON.stringify({ type: "delta", delta }));
  await sleep(600);
  check("A8 a viewer can't wipe pages, styles or variables with a comment", rawMsgs.filter((m) => m.type === "ack" && m.rejected).length === 4 && (await owner.evaluate(() => window.__dt.doc().pages.length)) === pagesBefore && (await owner.evaluate(() => window.__dt.doc().comments.cx)) === undefined);
  raw.close();

  check("A no page errors",[owner, guest, viewer].every((p) => p.errors.length === 0), [owner, guest, viewer].flatMap((p) => p.errors).join(" | "));

  // ---- B. Distinct colours -----------------------------------------------------------------
  const o2 = await newPage("Oscar", { random: 0.0001 });
  const room2 = await startRoom(o2);
  const g1 = await newPage("Gus", { random: 0.0001 });
  await g1.goto(room2.link);
  await live(g1);
  const g2 = await newPage("Gwen", { random: 0.0001 });
  await g2.goto(room2.link);
  await live(g2);
  await sleep(1500);
  const colours = [];
  for (const p of [o2, g1, g2]) colours.push(await p.evaluate(() => getComputedStyle(document.querySelector("button[data-me]")).backgroundColor));
  const seen = await o2.evaluate(() => Object.values(window.__dt.collab().peers).map((p) => p.color));
  check("B two guests forced to one colour end with different colours (all three differ)", new Set(colours).size === 3, colours.join(" "));
  check("B ...and the owner sees them with those colours", seen.length === 2 && new Set(seen).size === 2, seen.join(" "));
} catch (e) {
  failed++;
  console.log("FAIL  A/B crashed  — " + (e?.stack ?? e));
}

// ---- C. Old relay ----------------------------------------------------------------------------
if (!ONLY.includes("C")) {
} else if (!OLD_RELAY) {
  console.log("SKIP  C (set E2E_OLD_RELAY to a relay built from 17065fb)");
} else {
  try {
    const o = await newPage("Olga", { relay: OLD_RELAY });
    await o.goto(EDITOR + "/");
    await o.click("button:has-text('New design file')");
    await o.waitForSelector("#dt-canvas");
    const made = await dispatch(o, { op: "ai", tool: "create_nodes", input: { nodes: [{ type: "rectangle", name: "Box A", x: 0, y: 0, width: 200, height: 120, fill: "#6D4AFF" }] } });
    const a = made.created[0].id;
    await o.evaluate(() => window.__dt.zoomToFit());
    await o.click(".tbtn[title='Share for live editing']");
    await o.waitForSelector(".share-dialog");
    await o.click("button:has-text('Share online')");
    check("C0 owner shares through the old relay", await live(o));
    const dialog = await text(o, ".share-dialog");
    check("C the relay-version notice is shown in the Share dialog", /older than your editor/.test(dialog));
    check("C ...and the dialog says view-only links need an updated relay", /View-only links need an updated relay/.test(dialog) && (await count(o, "#share-view-link")) === 0);
    const link = await o.evaluate(() => window.__dt.collab().link);
    await o.keyboard.press("Escape");
    const g = await newPage("Gina", { relay: OLD_RELAY });
    await g.goto(link);
    await live(g);
    await waitFor(g, (id) => !!window.__dt.doc().nodes[id], a);
    check("C the guest bar shows the notice too", /older than your editor/.test(await text(g, ".guest-bar, .relay-notice") + (await text(g, ".relay-notice"))));
    await o.mouse.move(700, 500);
    await g.click(".peer-avatars button.avatar >> nth=0");
    await o.evaluate(() => window.__dt.setViewport({ x: -200, y: -100, zoom: 0.6 }));
    check("C follow works on the old relay", await waitNear(o, g));
    await g.click(".follow-bar button:has-text('Stop following')");
    await dispatch(g, { op: "select", ids: [a] });
    await o.waitForSelector(".remote-tag", { timeout: 5000 }).catch(() => {});
    check("C names on selections work on the old relay", (await text(o, ".remote-tag")) === "Gina");
    await g.mouse.move(300, 300);
    await o.evaluate(() => document.getElementById("dt-canvas").focus());
    await o.mouse.move(600, 400);
    await o.mouse.move(640, 420);
    await o.keyboard.press("/");
    await o.keyboard.type("hello");
    check("C cursor chat works on the old relay", await waitFor(g, () => [...document.querySelectorAll(".chat-bubble")].some((b) => b.textContent === "hello"), null, 4000));
    // Changes are rewritten for an old relay on the way out (model 0): ordinary edits still flow.
    await dispatch(o, { op: "update", ids: [a], patch: { x: 321 } });
    check("C edits flow through the downgrade path to the guest", await waitFor(g, (id) => window.__dt.doc().nodes[id]?.x === 321, a));
    // A change the relay can't take (a value it has no name for, which the downgrade tables
    // missed) is turned down: the author is told, and it is undone.
    await o.evaluate((id) => {
      const orig = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) {
        if (window.__bad && typeof d === "string" && d.includes('"type":"delta"')) {
          const m = JSON.parse(d);
          m.delta.patch = { [id]: { fills: [{ type: "angularGradient", stops: [] }] } };
          d = JSON.stringify(m);
        }
        return orig.call(this, d);
      };
      window.__bad = true;
    }, a);
    await dispatch(o, { op: "update", ids: [a], patch: { x: 555 } });
    await waitFor(o, () => /older than this editor/.test(document.querySelector(".toast.error")?.textContent ?? ""), null, 5000);
    await o.evaluate(() => (window.__bad = false));
    check("C a change the old relay rejects shows 'older than this editor' and is undone", /older than this editor/.test(await text(o, ".toast.error")) && (await nodes(o))[a].x === 321, await text(o, ".toast.error"));
    // A hand-made view link.
    const v = await newPage("Vera", { relay: OLD_RELAY });
    const fake = "0123456789abcdef0123456789abcdef";
    await v.goto(`${EDITOR}/?view=${fake}&relay=${encodeURIComponent(OLD_RELAY)}`);
    const said = await waitFor(v, () => /can't open view-only links/.test(document.body.textContent ?? ""), null, 15000);
    await sleep(6000);
    const attempts = v.sockets.filter((u) => u.includes("view=")).length;
    check("C a view link to an old relay says it can't open view-only links within 15 s", said, await text(v, ".guest-bar"));
    check("C ...and stops reconnecting (at most 3 WebSocket attempts)", attempts >= 1 && attempts <= 3, `${attempts} attempts`);
    check("C no page errors", [o, g, v].every((p) => p.errors.length === 0), [o, g, v].flatMap((p) => p.errors).join(" | "));
  } catch (e) {
    failed++;
    console.log("FAIL  C crashed  — " + (e?.stack ?? e));
  }
}

// ---- D. Old editor, new relay ----------------------------------------------------------------
if (!ONLY.includes("D")) {
} else if (!OLD_EDITOR) {
  console.log("SKIP  D (set E2E_OLD_EDITOR to the web/dist of 17065fb, served)");
} else {
  try {
    const o = await newPage("Olga");
    const room = await startRoom(o);
    const oldGuest = await newPage("Oldie", { editor: OLD_EDITOR });
    const oldLink = new URL(room.link);
    const target = new URL(OLD_EDITOR + "/");
    oldLink.protocol = target.protocol;
    oldLink.host = target.host;
    oldLink.pathname = target.pathname;
    oldLink.searchParams.set("relay", RELAY);
    await oldGuest.goto(oldLink.toString());
    check("D the old editor joins and gets the file", (await live(oldGuest)) && (await waitFor(oldGuest, (id) => !!window.__dt.doc().nodes[id], room.a)), `${oldGuest.url()} ${oldGuest.errors.join("|")} ${oldGuest.sockets.join(",")}`);
    await dispatch(o, { op: "update", ids: [room.a], patch: { x: 123 } });
    check("D the new editor's edit reaches the old one", await waitFor(oldGuest, (id) => window.__dt.doc().nodes[id]?.x === 123, room.a));
    await dispatch(oldGuest, { op: "update", ids: [room.a], patch: { y: 77 } });
    check("D the old editor's edit reaches the new one", await waitFor(o, (id) => window.__dt.doc().nodes[id]?.y === 77, room.a));
    await waitFor(o, () => Object.keys(window.__dt.collab().peers).length === 1);
    await o.keyboard.press("Escape");
    await o.click(".peer-avatars button.avatar >> nth=0");
    await o.mouse.move(600, 400);
    await o.mouse.move(640, 420);
    await o.evaluate(() => document.getElementById("dt-canvas").focus());
    await o.keyboard.press("/");
    await o.keyboard.type("hi old editor");
    await o.evaluate(() => window.__dt.setViewport({ x: -50, y: -50, zoom: 0.7 }));
    await sleep(1200);
    check("D no page errors in the old editor while the new one follows and chats", oldGuest.errors.length === 0, oldGuest.errors.join(" | "));
  } catch (e) {
    failed++;
    console.log("FAIL  D crashed  — " + (e?.stack ?? e));
  }
}

for (const c of contexts) await c.close().catch(() => {});
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
