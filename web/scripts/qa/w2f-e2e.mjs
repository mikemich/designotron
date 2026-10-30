// Wave 1 follow-ups (W2-F): storage failures outside autosave show an error and reset the UI,
// a file that can't be read right now isn't called missing, the view-only player's Remix opens
// on this editor, and two people editing different styles, variables or pages at the same
// moment both keep their change. Needs a relay serving the built editor:
//   cargo run -p designotron-relay -- --port 8787 --static web/dist
//   E2E_RELAY=http://127.0.0.1:8787 node scripts/qa/w2f-e2e.mjs

import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = (process.env.E2E_RELAY ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch(launch);
const newPage = async (name, { editorUrl } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // Nothing leaves this machine.
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    return u.startsWith(BASE) || /^(data|blob):/.test(u) ? route.continue() : route.abort();
  });
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  p.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Renamed file" : undefined));
  await p.addInitScript(
    ([n, editor]) => {
      try {
        localStorage.setItem("dt:tour-done", "1");
        localStorage.setItem("dt:userName", n);
        if (editor) localStorage.setItem("dt:editorUrl", editor);
      } catch {
        /* sandboxed */
      }
      // Storage that fails on demand (sessionStorage flags survive reloads of the tab).
      const flag = (k) => {
        try {
          return !!sessionStorage.getItem(k);
        } catch {
          return false;
        }
      };
      for (const [method, key] of [["put", "failWrite"], ["delete", "failWrite"], ["get", "failRead"]]) {
        const orig = IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method] = function (...a) {
          if (flag(key)) throw new DOMException("storage failed", "QuotaExceededError");
          return orig.apply(this, a);
        };
      }
      // Incoming room messages can be held back, to make two people's edits truly concurrent.
      const Orig = WebSocket;
      window.WebSocket = class extends Orig {
        set onmessage(fn) {
          super.onmessage = (e) => (window.__delayIn ? setTimeout(() => fn(e), window.__delayIn) : fn(e));
        }
        get onmessage() {
          return super.onmessage;
        }
      };
    },
    [name, editorUrl ?? ""],
  );
  return p;
};
const setFlag = (p, key, on) => p.evaluate(([k, on]) => (on ? sessionStorage.setItem(k, "1") : sessionStorage.removeItem(k)), [key, on]);
const toastText = (p) => p.locator(".toast.error").first().innerText({ timeout: 4000 }).catch(() => "");
const waitFor = (p, fn, arg) => p.waitForFunction(fn, arg, { timeout: 10000 }).then(() => true, () => false);
const dispatch = (p, cmd) => p.evaluate((c) => window.__dt.dispatch(c), cmd);
const newFile = async (p) => {
  await p.click("button:has-text('New design file')");
  await p.waitForSelector("#dt-canvas");
};

try {
  // ---- Storage failures outside autosave --------------------------------------------------
  const p = await newPage("Sto");
  await p.goto(BASE);
  await p.waitForSelector("button:has-text('New design file')");
  await newFile(p);
  await dispatch(p, { op: "ai", tool: "create_nodes", input: { nodes: [{ type: "rectangle", name: "Box", x: 0, y: 0, width: 100, height: 100, fill: "#f00" }] } });
  await sleep(1800);
  const fileHash = await p.evaluate(() => location.hash);

  // A version to restore later.
  await p.click("[role=tab]:has-text('History')");
  await p.click("button:has-text('Save')");
  await waitFor(p, () => document.querySelectorAll(".version").length === 1);

  await p.evaluate(() => (location.hash = "#/"));
  await p.waitForSelector(".file-card .more");
  await sleep(400);

  await setFlag(p, "failWrite", true);
  await p.click("button:has-text('New design file')");
  check("a failed create shows an error", /Couldn't create the file/.test(await toastText(p)), await toastText(p));
  check("...and stays on the dashboard with the button ready", (await p.evaluate(() => location.hash)) === "#/" && (await p.locator("button.primary:has-text('New design file')").count()) === 1);

  const menu = async (label) => {
    await p.click(".file-card .more");
    await p.click(`.menu >> text=${label}`).catch(async () => p.click(`text="${label}"`));
  };
  await menu("Rename");
  check("a failed rename shows an error", /Couldn't rename the file/.test(await toastText(p)), await toastText(p));
  await sleep(5200);
  await menu("Duplicate");
  check("a failed duplicate shows an error", /Couldn't duplicate the file/.test(await toastText(p)), await toastText(p));
  await sleep(5200);
  await menu("Delete");
  check("a failed delete shows an error and keeps the file", /Couldn't delete the file/.test(await toastText(p)) && (await p.locator(".file-card:has(.more)").count()) === 1, await toastText(p));
  await setFlag(p, "failWrite", false);
  check("the file is untouched after the failures", (await p.locator(".file-card .n", { hasText: "Renamed file" }).count()) === 0 && (await p.locator(".file-card:has(.more)").count()) === 1);

  // History: save, restore.
  await p.evaluate((h) => (location.hash = h), fileHash);
  await p.waitForSelector("#dt-canvas");
  await p.click("[role=tab]:has-text('History')");
  await waitFor(p, () => document.querySelectorAll(".version").length === 1);
  await setFlag(p, "failWrite", true);
  await p.click("button:has-text('Save')");
  check("a failed version save shows an error", /Couldn't save the version/.test(await toastText(p)), await toastText(p));
  await sleep(5200);
  await p.hover(".version");
  await p.click(".version [title='Restore this version']");
  check("a failed restore shows an error", /Couldn't restore the version/.test(await toastText(p)), await toastText(p));
  check("...and changes nothing", (await p.locator(".version").count()) === 1 && Object.values(await p.evaluate(() => window.__dt.doc().nodes)).some((n) => n.name === "Box"));
  await setFlag(p, "failWrite", false);
  await sleep(5200);

  // A file that can't be read right now isn't "not in this browser".
  await p.evaluate(() => (location.hash = "#/"));
  await p.waitForSelector(".file-card .more");
  await sleep(300);
  await setFlag(p, "failRead", true);
  await p.click(".file-card:has(.more)");
  await p.waitForSelector("button:has-text('Try again')", { timeout: 8000 }).catch(() => {});
  await sleep(200);
  const body = await p.locator("body").innerText();
  check("an unreadable file offers a retry and isn't called missing", /Try again/.test(body) && !/isn't in this browser/.test(body), body.slice(0, 120).replace(/\n/g, " | "));
  await setFlag(p, "failRead", false);
  await p.click("button:has-text('Try again')");
  check("Try again opens the file", await waitFor(p, () => !!document.querySelector("#dt-canvas")));
  check("...with its content", Object.values(await p.evaluate(() => window.__dt.doc().nodes)).some((n) => n.name === "Box"));
  await p.evaluate(() => (location.hash = "#/file/fnosuchfile"));
  await p.waitForSelector("text=isn't in this browser", { timeout: 8000 }).catch(() => {});
  check("a file that really isn't here still says so", (await p.locator("text=isn't in this browser").count()) === 1);

  // ---- Viewer Remix opens on this editor -------------------------------------------------
  const make = await newPage("Mk");
  await make.goto(BASE);
  await newFile(make);
  await dispatch(make, { op: "ai", tool: "create_nodes", input: { nodes: [{ type: "frame", name: "Screen", x: 0, y: 0, width: 300, height: 200, fill: "#FFFFFF" }] } });
  const data = await make.evaluate(async () => {
    const json = JSON.stringify({ v: 1, doc: window.__dt.doc(), assets: {} });
    const gz = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    let s = "";
    for (const b of gz) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  });
  const remix = async (editorUrl) => {
    const v = await newPage("Vw", { editorUrl });
    await v.goto(`${BASE}/#/view/${data}`);
    await v.waitForSelector("a.remix", { timeout: 10000 }).catch(() => {});
    const href = await v.locator("a.remix").getAttribute("href").catch(() => null);
    await v.context().close();
    return href;
  };
  const here = await remix();
  check("Remix opens a copy on this editor, not the hosted one", !!here && here.startsWith(`${BASE}/#/copy/`) && !here.includes("github.io"), String(here).slice(0, 70));
  const away = await remix("https://editor.example/app/");
  check("a dt:editorUrl override still redirects it", !!away && away.startsWith("https://editor.example/app/#/copy/"), String(away).slice(0, 70));

  // ---- Concurrent edits of different styles, variables and pages -------------------------
  const owner = await newPage("Olga");
  await owner.goto(BASE);
  await newFile(owner);
  await owner.click(".tbtn[title='Share for live editing']");
  await owner.waitForSelector(".share-dialog");
  await sleep(500);
  if (!(await owner.locator(".share-dialog input.mono").count())) await owner.click("text=Use a different relay");
  await owner.fill(".share-dialog input.mono", BASE);
  await owner.click("button:has-text('Share online')");
  await owner.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 10000 });
  const link = await owner.evaluate(() => window.__dt.collab().link);
  await owner.keyboard.press("Escape");
  const ann = await newPage("Ann");
  await ann.goto(link);
  await ann.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 15000 });

  const mode = (id) => ({ id, name: id });
  const variable = (id, v) => ({ id, name: id, type: "number", values: { m1: v }, description: "" });
  await dispatch(owner, { op: "addColorStyle", name: "One", color: "#111111" });
  await dispatch(owner, { op: "addColorStyle", name: "Two", color: "#222222" });
  await dispatch(owner, { op: "setVariables", collections: [{ id: "c", name: "C", modes: [mode("m1")], variables: [variable("a", 1), variable("b", 1)] }] });
  await dispatch(owner, { op: "addPage" });
  await sleep(800);
  const synced = await waitFor(ann, () => window.__dt.doc().styles.colors.length === 2 && window.__dt.doc().pages.length === 2 && window.__dt.doc().variables[0]?.variables.length === 2);
  check("Ann has the styles, variables and pages", synced);
  const ids = await owner.evaluate(() => ({ s: window.__dt.doc().styles.colors.map((s) => s.id), p: window.__dt.doc().pages.map((p) => p.id) }));

  // Ann hears nothing for a moment, so both edit from the same starting point.
  const concurrently = async (mine, hers) => {
    await ann.evaluate(() => (window.__delayIn = 700));
    await mine();
    await sleep(100);
    await hers();
    await sleep(1800);
    await ann.evaluate(() => (window.__delayIn = 0));
    await sleep(600);
  };
  const same = async (f) => JSON.stringify(await owner.evaluate(f)) === JSON.stringify(await ann.evaluate(f));
  const stylesOf = () => window.__dt.doc().styles.colors.map((s) => [s.id, s.name, s.color]);
  const varsOf = () => window.__dt.doc().variables.map((c) => c.variables.map((v) => [v.id, v.values]));
  const pagesOf = () => window.__dt.doc().pages.map((p) => [p.id, p.name]);

  await concurrently(
    () => dispatch(owner, { op: "updateColorStyle", id: ids.s[0], color: "#AA0000" }),
    () => dispatch(ann, { op: "updateColorStyle", id: ids.s[1], name: "Renamed by Ann" }),
  );
  const st = await owner.evaluate(stylesOf);
  check(
    "two people editing different styles both keep their change",
    st.find((s) => s[0] === ids.s[0])?.[2] === "#AA0000" && st.find((s) => s[0] === ids.s[1])?.[1] === "Renamed by Ann" && (await same(stylesOf)),
    JSON.stringify(st),
  );

  await concurrently(
    () => dispatch(owner, { op: "setVariables", collections: [{ id: "c", name: "C", modes: [mode("m1")], variables: [variable("a", 5), variable("b", 1)] }] }),
    () => dispatch(ann, { op: "setVariables", collections: [{ id: "c", name: "C", modes: [mode("m1")], variables: [variable("a", 1), variable("b", 9)] }] }),
  );
  const vs = await owner.evaluate(varsOf);
  check("...different variables", vs[0][0][1].m1 === 5 && vs[0][1][1].m1 === 9 && (await same(varsOf)), JSON.stringify(vs));

  await concurrently(
    () => dispatch(owner, { op: "renamePage", id: ids.p[0], name: "Owner's page" }),
    () => dispatch(ann, { op: "renamePage", id: ids.p[1], name: "Ann's page" }),
  );
  const pg = await owner.evaluate(pagesOf);
  check("...different pages", pg[0][1] === "Owner's page" && pg[1][1] === "Ann's page" && (await same(pagesOf)), JSON.stringify(pg));

  const errors = [p, make, owner, ann].flatMap((x) => x.errors);
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
