// Prototyping depth: scrolling frames with fixed layers, Scroll to, interactive components
// (Change to), mouse and key triggers, durations and easing, Push/Back, smart animate, and the
// view link playing the same things.
// Usage: E2E_URL=http://localhost:5173 node scripts/qa/w3a-e2e.mjs (dev server running)
// Screenshots go to E2E_OUT (default /tmp/w3a-shots).

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const OUT = process.env.E2E_OUT ?? "/tmp/w3a-shots";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
// Nothing leaves the machine.
await context.route("**/*", (route) => {
  const u = route.request().url();
  if (u.startsWith("data:") || u.startsWith("blob:") || /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)) return route.continue();
  return route.abort();
});
await context.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
  // window.open is how Open link reaches the page; count the calls instead of opening anything.
  window.__opens = [];
  window.open = (u) => (window.__opens.push(String(u)), null);
});
const errors = [];
const watch = (p) => {
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("console", (m) => m.type() === "error" && !/WebSocket|Failed to load resource/.test(m.text()) && errors.push(m.text()));
};

const page = await context.newPage();
watch(page);
await page.goto(URL);
await page.click("button:has-text('New design file')");
await page.waitForSelector("#dt-canvas");

const doc = (p = page) => p.evaluate(() => window.__dt.doc());
const tool = (name, input, p = page) => p.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const dispatch = (cmd, p = page) => p.evaluate((c) => window.__dt.dispatch(c), cmd);
const ids = {};
const refresh = async () => {
  for (const n of Object.values((await doc()).nodes)) ids[n.name] = n.id;
};
const proto = async (name, input) => {
  const r = await tool("set_prototype", { nodeId: ids[name], ...Object.fromEntries(Object.entries(input).map(([k, v]) => [k, k === "destinationId" ? ids[v] : v])) });
  if (!r.ok) throw new Error(`set_prototype ${name}: ${JSON.stringify(r)}`);
};
const update = (name, patch) => dispatch({ op: "update", ids: [ids[name]], patch });
const crumb = (p) => p.locator(".presenter .bar .muted").innerText().then((t) => t.trim());
const hot = (p, name) => p.locator(`.presenter [data-hotspot="${ids[name]}"]`);
const rectOf = (loc) => loc.evaluate((e) => {
  const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
const shot = (p, name) => p.screenshot({ path: path.join(OUT, `w3a-${name}.png`) });
const present = async (p, frame) => {
  // Present starts at the page's flow starting point.
  const pg = await p.evaluate(() => window.__dt.state().page);
  await dispatch({ op: "setFlowStart", page: pg, id: ids[frame] }, p);
  // Present starts at the selected frame when there is one (Wave 4): clear the selection.
  await dispatch({ op: "select", ids: [] }, p);
  await p.click("button[title='Present']");
  await p.waitForSelector(".presenter");
  await sleep(250);
};
const closePresent = async (p) => {
  await p.keyboard.press("Escape");
  await p.waitForSelector(".presenter", { state: "detached" });
};

// ---------- fixtures ----------

const card = (name, x) => ({ type: "rectangle", name, x, y: 10, width: 300, height: 180, fill: "#7C5CFF" });
await tool("create_nodes", {
  nodes: [
    // 1-3: a 390x844 feed that scrolls vertically: fixed nav, a carousel, a tall body, items.
    {
      type: "frame", name: "Feed", x: 0, y: 0, width: 390, height: 844, fill: "#FFFFFF",
      children: [
        { type: "rectangle", name: "Body", x: 0, y: 0, width: 390, height: 2000, fill: "#EEEEEE" },
        { type: "rectangle", name: "Item", x: 20, y: 1200, width: 350, height: 60, fill: "#22AA55" },
        { type: "rectangle", name: "Footer", x: 0, y: 1000, width: 390, height: 100, fill: "#333333" },
        { type: "rectangle", name: "Jump", x: 20, y: 520, width: 120, height: 40, fill: "#FF8800" },
        {
          type: "frame", name: "Carousel", x: 0, y: 300, width: 390, height: 200, fill: "#DDDDDD",
          children: [card("Card 1", 10), card("Card 2", 320), card("Card 3", 630), card("Card 4", 940), card("Card 5", 1250)],
        },
        { type: "rectangle", name: "Dots", x: 150, y: 460, width: 90, height: 30, fill: "#FF0000" },
        { type: "rectangle", name: "Nav", x: 0, y: 0, width: 390, height: 80, fill: "#111111" },
      ],
    },
    { type: "frame", name: "Detail", x: 500, y: 0, width: 390, height: 844, fill: "#FFFFFF" },
    // 6-7: hover, mouse enter/leave, key.
    {
      type: "frame", name: "Hover A", x: 1000, y: 0, width: 390, height: 844, fill: "#FFFFFF",
      children: [
        { type: "rectangle", name: "Hover box", x: 20, y: 100, width: 150, height: 100, fill: "#FF0066" },
        { type: "rectangle", name: "Enter box", x: 20, y: 300, width: 150, height: 100, fill: "#0066FF" },
        { type: "rectangle", name: "Key box", x: 20, y: 500, width: 150, height: 100, fill: "#00AA66" },
        { type: "rectangle", name: "Bang box", x: 200, y: 500, width: 150, height: 100, fill: "#AA00AA" },
      ],
    },
    // Layers after a carousel that sits inside a plain frame: over it, and below it.
    {
      type: "frame", name: "Zsec", x: 6000, y: 0, width: 390, height: 844, fill: "#FFFFFF",
      children: [
        {
          type: "frame", name: "Section", x: 0, y: 0, width: 390, height: 700, fill: "#F5F5F5", clipContent: true,
          children: [
            {
              type: "frame", name: "Carousel Z", x: 0, y: 100, width: 390, height: 200, fill: "#DDDDDD",
              children: [card("Z1", 10), card("Z2", 320), card("Z3", 630)],
            },
            { type: "rectangle", name: "Dots over", x: 150, y: 210, width: 90, height: 30, fill: "#FE0000" },
            { type: "rectangle", name: "Dots below", x: 150, y: 320, width: 90, height: 30, fill: "#FD0000" },
          ],
        },
      ],
    },
    { type: "frame", name: "Esc A", x: 6500, y: 0, width: 390, height: 844, fill: "#FFFFFF", children: [{ type: "rectangle", name: "Esc open", x: 20, y: 100, width: 150, height: 60, fill: "#0066FF" }] },
    { type: "frame", name: "Esc Modal", x: 7000, y: 0, width: 200, height: 100, fill: "#FFFF99" },
    { type: "frame", name: "Hover B", x: 1500, y: 0, width: 390, height: 844, fill: "#FFFF99" },
    // 8-9: durations, easing, push and back.
    {
      type: "frame", name: "Motion A", x: 2000, y: 0, width: 390, height: 844, fill: "#FFFFFF",
      children: [
        { type: "rectangle", name: "Dissolve btn", x: 20, y: 100, width: 150, height: 60, fill: "#FF0066" },
        { type: "rectangle", name: "Old btn", x: 20, y: 200, width: 150, height: 60, fill: "#0066FF" },
        { type: "rectangle", name: "Push btn", x: 20, y: 300, width: 150, height: 60, fill: "#00AA66" },
        { type: "rectangle", name: "Slide btn", x: 20, y: 400, width: 150, height: 60, fill: "#AA00AA" },
      ],
    },
    { type: "frame", name: "Motion B", x: 2500, y: 0, width: 390, height: 844, fill: "#FFFF99" },
    // 10: smart animate between two frames with a layer of the same name.
    {
      type: "frame", name: "Smart A", x: 3000, y: 0, width: 390, height: 844, fill: "#FFFFFF",
      children: [{ type: "rectangle", name: "Card", x: 20, y: 100, width: 100, height: 100, fill: "#7C5CFF" }],
    },
    {
      type: "frame", name: "Smart B", x: 3500, y: 0, width: 390, height: 844, fill: "#FFFFFF",
      children: [
        { type: "rectangle", name: "Card", x: 200, y: 100, width: 100, height: 100, fill: "#7C5CFF" },
        { type: "rectangle", name: "Badge", x: 200, y: 400, width: 80, height: 80, fill: "#FF8800" },
      ],
    },
    // 4-5: a toggle component set, and screens to use it on.
    {
      type: "frame", name: "State=Off", x: 4000, y: 0, width: 120, height: 50, fill: "#CCCCCC",
      children: [
        { type: "rectangle", name: "Knob", x: 4, y: 4, width: 20, height: 20, fill: "#FF0000" },
        { type: "text", name: "Label", x: 40, y: 8, text: "Label", fontSize: 14 },
      ],
    },
    {
      type: "frame", name: "State=On", x: 4200, y: 0, width: 120, height: 50, fill: "#CCCCCC",
      children: [
        { type: "rectangle", name: "Knob", x: 96, y: 4, width: 20, height: 20, fill: "#00AA00" },
        { type: "text", name: "Label", x: 40, y: 8, text: "Label", fontSize: 14 },
      ],
    },
    {
      type: "frame", name: "Settings", x: 4500, y: 0, width: 390, height: 844, fill: "#FFFFFF",
      children: [{ type: "rectangle", name: "Next", x: 20, y: 400, width: 120, height: 40, fill: "#FF8800" }],
    },
    { type: "frame", name: "Other", x: 5000, y: 0, width: 390, height: 844, fill: "#FFFF99", children: [{ type: "rectangle", name: "Return", x: 20, y: 20, width: 120, height: 40, fill: "#FF8800" }] },
  ],
});
await refresh();
// Variants: combine the two components into a set named by their properties.
for (const n of ["State=Off", "State=On"]) await dispatch({ op: "createComponent", ids: [ids[n]] });
await refresh();
const offId = Object.values((await doc()).nodes).find((n) => n.type === "component" && n.name === "State=Off")?.id;
const onId = Object.values((await doc()).nodes).find((n) => n.type === "component" && n.name === "State=On")?.id;
const set = await dispatch({ op: "combineVariants", ids: [offId, onId] });
check("fixtures: a component set with two variants", !!set?.id && (await doc()).nodes[set.id].children.length === 2);
const instance = (await dispatch({ op: "createInstance", componentId: offId, x: 4540, y: 200, parent: ids["Settings"] })).id;
ids["Toggle"] = instance;
await dispatch({ op: "update", ids: [instance], patch: { name: "Toggle" } });
{
  const d = await doc();
  const l = d.nodes[instance].children.find((c) => d.nodes[c].name === "Label");
  await dispatch({ op: "update", ids: [l], patch: { text: { characters: "Wi-Fi" } } });
}
await refresh();
// Variant interactions: Off -> On, On -> Off (set on each variant's root).
ids["Off"] = offId;
ids["On"] = onId;
{
  const r1 = await tool("set_prototype", { nodeId: ids["Off"], action: "change_to", destinationId: ids["On"] });
  const r2 = await tool("set_prototype", { nodeId: ids["On"], action: "change_to", destinationId: ids["Off"] });
  check("set_prototype accepts change_to between variants", r1.ok && r2.ok, JSON.stringify([r1, r2]));
  const wrong = await tool("set_prototype", { nodeId: ids["Off"], action: "change_to", destinationId: ids["Detail"] });
  check("change_to a non-variant is refused", !wrong.ok, JSON.stringify(wrong));
}

// Scrolling is set in the panel; the rest through the tools.
await dispatch({ op: "select", ids: [ids["Feed"]] });
await page.click("#right-tab-prototype");
await page.waitForSelector("select[aria-label='Overflow scrolling']");
const hintBefore = await page.locator("text=content needs to be bigger").count();
await page.selectOption("select[aria-label='Overflow scrolling']", "vertical");
await sleep(150);
check("panel: Overflow scrolling sets the frame's overflow", (await doc()).nodes[ids["Feed"]].overflow === "vertical");
check("panel: no hint when the content is bigger than the frame", hintBefore === 0 && (await page.locator("text=content needs to be bigger").count()) === 0);
await dispatch({ op: "select", ids: [ids["Nav"]] });
await page.waitForSelector("select[aria-label='Position when scrolling']");
await page.selectOption("select[aria-label='Position when scrolling']", "fixed");
await sleep(150);
check("panel: Position when scrolling sets Fixed", (await doc()).nodes[ids["Nav"]].scrollBehavior === "fixed");
await dispatch({ op: "select", ids: [ids["Carousel"]] });
await page.selectOption("select[aria-label='Overflow scrolling']", "horizontal");
await sleep(100);
check("panel: a nested frame gets its own overflow", (await doc()).nodes[ids["Carousel"]].overflow === "horizontal");
// A frame whose content fits shows the hint.
await dispatch({ op: "select", ids: [ids["Detail"]] });
await page.selectOption("select[aria-label='Overflow scrolling']", "vertical");
await sleep(100);
check("panel: hint when the content isn't bigger than the frame", (await page.locator("text=content needs to be bigger").count()) === 1);
await page.selectOption("select[aria-label='Overflow scrolling']", "none");

await proto("Item", { action: "navigate", destinationId: "Detail", transition: "instant" });
await proto("Nav", { action: "navigate", destinationId: "Detail", transition: "instant" });
await proto("Card 1", { action: "navigate", destinationId: "Detail", transition: "instant" });
await proto("Jump", { action: "scroll_to", destinationId: "Footer" });
await proto("Footer", { action: "navigate", destinationId: "Detail", transition: "instant" });
await update("Carousel Z", { overflow: "horizontal" });
await proto("Dots over", { action: "navigate", destinationId: "Detail", transition: "instant" });
await proto("Dots below", { action: "navigate", destinationId: "Detail", transition: "instant" });
await proto("Esc open", { action: "open_overlay", destinationId: "Esc Modal", transition: "instant" });
await proto("Esc A", { trigger: "key", key: "Escape", action: "navigate", destinationId: "Detail", transition: "instant" });
await proto("Dots", { action: "navigate", destinationId: "Detail", transition: "instant" });

// ---------- 1-3: scrolling, nested scrolling, Scroll to ----------

async function scrolling(p, label) {
  await present(p, "Feed");
  const scrollerEl = p.locator(`.presenter [data-scroller="${ids["Feed"]}"]`);
  check(`${label}: the feed is a scroller`, (await scrollerEl.count()) === 1);
  const sbox = await rectOf(scrollerEl);
  const item0 = await rectOf(hot(p, "Item"));
  const nav0 = await rectOf(hot(p, "Nav"));
  await p.mouse.move(sbox.x + 200, sbox.y + 700);
  await p.mouse.wheel(0, 600);
  await sleep(400);
  const item1 = await rectOf(hot(p, "Item"));
  const nav1 = await rectOf(hot(p, "Nav"));
  const top = await scrollerEl.evaluate((e) => e.scrollTop);
  check(`${label}: wheel scrolls the content by 600`, near(top, 600, 2) && near(item1.y - item0.y, -600, 2), `scrollTop ${top}, item moved ${item1.y - item0.y}`);
  check(`${label}: the hotspot at y=1200 is now inside the viewport`, item1.y >= sbox.y && item1.y + item1.height <= sbox.y + sbox.height, `${item1.y} in ${sbox.y}..${sbox.y + sbox.height}`);
  check(`${label}: the fixed nav didn't move`, near(nav1.y, nav0.y, 0.5) && near(nav1.x, nav0.x, 0.5));
  await shot(p, `${label}-scrolled`);
  await hot(p, "Item").click();
  await sleep(150);
  check(`${label}: clicking a hotspot after scrolling navigates`, (await crumb(p)) === "Detail", await crumb(p));
  await closePresent(p);

  // Nested: the carousel scrolls sideways without scrolling the page.
  await present(p, "Feed");
  const car = p.locator(`.presenter [data-scroller="${ids["Carousel"]}"]`);
  check(`${label}: the carousel is a scroller inside the feed`, (await car.count()) === 1);
  const cbox = await rectOf(car);
  const c0 = await rectOf(hot(p, "Card 1"));
  const page0 = await p.locator(`.presenter [data-scroller="${ids["Feed"]}"]`).evaluate((e) => e.scrollTop);
  await p.mouse.move(cbox.x + 200, cbox.y + 100);
  await p.mouse.wheel(300, 0);
  await sleep(400);
  const c1 = await rectOf(hot(p, "Card 1"));
  const page1 = await p.locator(`.presenter [data-scroller="${ids["Feed"]}"]`).evaluate((e) => e.scrollTop);
  check(`${label}: scrolling the carousel moves its cards`, near(c1.x - c0.x, -300, 2), `moved ${c1.x - c0.x}`);
  check(`${label}: ...and not the page`, page1 === page0);
  await p.mouse.move(cbox.x + 200, cbox.y + 100);
  await p.mouse.wheel(0, 200);
  await sleep(400);
  const page2 = await p.locator(`.presenter [data-scroller="${ids["Feed"]}"]`).evaluate((e) => e.scrollTop);
  check(`${label}: a vertical wheel over the carousel scrolls the page`, near(page2, 200, 2), `scrollTop ${page2}`);
  await closePresent(p);

  // A layer painted after the carousel is drawn over it and gets the click.
  await present(p, "Feed");
  const dots = await rectOf(hot(p, "Dots"));
  const topEl = await p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute("data-hotspot"), [dots.x + dots.width / 2, dots.y + dots.height / 2]);
  check(`${label}: a layer after the carousel is on top of it`, topEl === ids["Dots"], String(topEl));
  const red = await p.evaluate(([x, y]) => {
    const els = document.elementsFromPoint(x, y);
    return els.some((e) => e.tagName === "svg" && e.innerHTML.toLowerCase().includes("ff0000"));
  }, [dots.x + dots.width / 2, dots.y + dots.height / 2]);
  check(`${label}: ...and it is drawn`, red);
  await hot(p, "Dots").click();
  await sleep(150);
  check(`${label}: ...and clicking it navigates`, (await crumb(p)) === "Detail", await crumb(p));
  await closePresent(p);
}
await scrolling(page, "scroll");

// Scroll to.
await present(page, "Feed");
{
  const scrollerEl = page.locator(`.presenter [data-scroller="${ids["Feed"]}"]`);
  await hot(page, "Jump").click();
  await sleep(1000);
  const sb = await rectOf(scrollerEl);
  const fb = await rectOf(hot(page, "Footer"));
  check("scroll to: the footer's top reaches the scroller's top", near(fb.y, sb.y, 2), `footer ${fb.y} scroller ${sb.y}`);
}
await closePresent(page);

// ---------- 4-5: interactive components ----------

const stageHtml = (p) => p.locator(".presenter .stage").first().innerHTML();
const knob = async (p) => {
  const h = (await stageHtml(p)).toLowerCase();
  return { on: h.includes("00aa00"), off: h.includes("ff0000"), wifi: h.includes("wi-fi") };
};
async function toggle(p, label) {
  await present(p, "Settings");
  let k = await knob(p);
  check(`${label}: starts Off with the instance's text`, k.off && !k.on && k.wifi, JSON.stringify(k));
  await hot(p, "Toggle").click();
  await sleep(300);
  k = await knob(p);
  check(`${label}: click switches to the On variant, keeping the Wi-Fi label`, k.on && !k.off && k.wifi, JSON.stringify(k));
  await shot(p, `${label}-on`);
  // State is remembered while navigating.
  await hot(p, "Next").click();
  await sleep(200);
  check(`${label}: navigated away`, (await crumb(p)) === "Other");
  await hot(p, "Return").click();
  await sleep(200);
  k = await knob(p);
  check(`${label}: navigating away and back keeps the state`, k.on && k.wifi, JSON.stringify(k));
  await hot(p, "Toggle").click();
  await sleep(300);
  k = await knob(p);
  check(`${label}: click again returns to Off`, k.off && !k.on && k.wifi, JSON.stringify(k));
  await closePresent(p);
  // The editor's document was never touched by the player.
  const d = await doc(p);
  check(`${label}: the editor's instance still shows Off`, d.nodes[ids["Toggle"]].instance.componentId === ids["Off"]);
}
await proto("Next", { action: "navigate", destinationId: "Other", transition: "instant" });
await proto("Return", { action: "navigate", destinationId: "Settings", transition: "instant" });
await toggle(page, "toggle");

// Same trigger on the instance wins over the variant's.
await proto("Toggle", { action: "navigate", destinationId: "Other", transition: "instant" });
await present(page, "Settings");
await hot(page, "Toggle").click();
await sleep(200);
check("precedence: the instance's own click navigates", (await crumb(page)) === "Other");
await page.click(".presenter .bar button[title='Back']");
await sleep(200);
{
  const k = await knob(page);
  check("precedence: ...and doesn't change the variant", k.off && !k.on, JSON.stringify(k));
}
await closePresent(page);
// A different trigger runs both: hover the instance changes it, click navigates.
await dispatch({ op: "update", ids: [ids["Toggle"]], patch: { interactions: [] } });

// ---------- 6: hovering, mouse enter and leave ----------

await proto("Hover box", { action: "navigate", destinationId: "Hover B", trigger: "hover", transition: "instant" });
await proto("Enter box", { action: "open_url", url: "https://example.com/enter", trigger: "mouse_enter" });
await tool("set_prototype", { nodeId: ids["Enter box"], action: "open_url", url: "https://example.com/leave", trigger: "mouse_leave" });
await proto("Key box", { action: "navigate", destinationId: "Hover B", trigger: "key", key: "shift+k", transition: "instant" });
await proto("Bang box", { action: "navigate", destinationId: "Hover B", trigger: "key", key: "shift+1", transition: "instant" });
await present(page, "Hover A");
{
  const hb = await rectOf(hot(page, "Hover box"));
  await page.mouse.move(hb.x + 10, hb.y + 10);
  await sleep(200);
  check("while hovering: the pointer on the layer shows the second screen", (await crumb(page)) === "Hover B", await crumb(page));
  await page.mouse.move(hb.x + 40, hb.y + 40);
  await sleep(100);
  check("while hovering: still there while the pointer stays on the layer", (await crumb(page)) === "Hover B");
  await page.mouse.move(hb.x + hb.width + 60, hb.y + hb.height + 60);
  await sleep(200);
  check("while hovering: off the layer, the first screen is back", (await crumb(page)) === "Hover A", await crumb(page));

  const eb = await rectOf(hot(page, "Enter box"));
  const opens = () => page.evaluate(() => window.__opens.slice());
  await page.mouse.move(eb.x + 10, eb.y + 10);
  for (const d of [20, 30, 50, 70]) await page.mouse.move(eb.x + d, eb.y + d);
  await sleep(150);
  let o = await opens();
  check("mouse enter: fires once for repeated moves inside", o.length === 1 && o[0].endsWith("/enter"), JSON.stringify(o));
  await page.mouse.move(eb.x + eb.width + 80, eb.y + eb.height + 80);
  await sleep(150);
  o = await opens();
  check("mouse leave: fires on leaving", o.length === 2 && o[1].endsWith("/leave"), JSON.stringify(o));

  // 7: Key triggers.
  await page.keyboard.press("k");
  await sleep(150);
  check("key: K alone does nothing", (await crumb(page)) === "Hover A");
  await page.keyboard.press("Shift+1");
  await sleep(150);
  check("key: Shift+1 fires although the browser sends \"!\"", (await crumb(page)) === "Hover B", await crumb(page));
  await page.click(".presenter .bar button[title='Back']");
  await sleep(150);
  await page.keyboard.press("Shift+K");
  await sleep(150);
  check("key: Shift+K navigates", (await crumb(page)) === "Hover B", await crumb(page));
}
await closePresent(page);

// ---------- panel: the Key field and the timing fields ----------

await dispatch({ op: "select", ids: [ids["Key box"]] });
await page.click("#right-tab-prototype");
await page.waitForSelector("button[aria-label='Trigger key']");
check("panel: a key interaction shows its key", (await page.locator("button[aria-label='Trigger key']").innerText()) === "Shift+K");
await page.click("button[aria-label='Trigger key']");
await page.keyboard.press("Control+Shift+L");
await sleep(150);
check("panel: the Key field captures the next key press", (await doc()).nodes[ids["Key box"]].interactions[0].key === "Ctrl+Shift+L", JSON.stringify((await doc()).nodes[ids["Key box"]].interactions[0]));
await dispatch({ op: "select", ids: [ids["Dissolve btn"]] });
await proto("Dissolve btn", { action: "navigate", destinationId: "Motion B", transition: "dissolve", duration: 1000, easing: "linear" });
await sleep(100);
check("panel: duration and easing show for a dissolve", (await page.locator("input[aria-label='Duration (ms)']").inputValue()) === "1000" && (await page.locator("select[aria-label='Easing']").inputValue()) === "linear");
await page.selectOption("select[aria-label='Transition']", "push");
await sleep(100);
check("panel: Push offers a direction", (await page.locator("select[aria-label='Direction']").count()) === 1);
await page.selectOption("select[aria-label='Transition']", "dissolve");
await dispatch({ op: "select", ids: [ids["Jump"]] });
check("panel: Scroll to lists the layers of the screen", (await page.locator("select[aria-label='Scroll to layer'] option").allInnerTexts()).includes("Footer"));
await dispatch({ op: "select", ids: [ids["Off"]] });
check("panel: Change to lists the variants of the set", (await page.locator("select[aria-label='Change to variant'] option").allInnerTexts()).some((t) => t.includes("On")));
await dispatch({ op: "select", ids: [ids["Feed"]] });

// ---------- 8-9: duration, easing, push, back ----------

await proto("Dissolve btn", { action: "navigate", destinationId: "Motion B", transition: "dissolve", duration: 1000, easing: "linear" });
// An interaction as an older version saved it: no easing, duration 0.
await dispatch({
  op: "update",
  ids: [ids["Old btn"]],
  patch: { interactions: [{ trigger: "onClick", delayMs: 800, action: "navigate", destination: ids["Motion B"], url: null, transition: "dissolve", durationMs: 0 }] },
});
await proto("Push btn", { action: "navigate", destinationId: "Motion B", transition: "push", direction: "left", duration: 700 });
const anim = (p, sel = ".presenter .stage") => p.locator(sel).first().evaluate((e) => ({ d: getComputedStyle(e).animationDuration, t: getComputedStyle(e).animationTimingFunction, n: getComputedStyle(e).animationName }));
await proto("Slide btn", { action: "navigate", destinationId: "Motion B", transition: "slide_left", duration: 700 });
await present(page, "Motion A");
await hot(page, "Dissolve btn").click();
await sleep(80);
{
  const a = await anim(page);
  check("transition: a 1000 ms linear dissolve is played as such", a.d === "1s" && a.t === "linear", JSON.stringify(a));
}
await page.click(".presenter .bar button[title='Back']");
await sleep(1200);
await hot(page, "Old btn").click();
await sleep(80);
{
  const a = await anim(page);
  check("transition: an old interaction plays 0.3s ease-out", a.d === "0.3s" && a.t === "ease-out", JSON.stringify(a));
}
await sleep(500);
await page.click(".presenter .bar button[title='Back']");
await sleep(500);
await hot(page, "Push btn").click();
await sleep(150);
{
  const n = await page.locator(".presenter .stage").count();
  const a = await anim(page, ".presenter .stage:not(.stage-leaving)");
  const b = await anim(page, ".presenter .stage-leaving");
  check("push: during the animation two screens are on stage", n === 2, `${n}`);
  check("push: the new one comes in and the old one goes out", a.n === "dt-in-left" && b.n === "dt-out-left", JSON.stringify([a, b]));
  await sleep(800);
  check("push: afterwards one screen", (await page.locator(".presenter .stage").count()) === 1);
  await page.click(".presenter .bar button[title='Back']");
  await sleep(150);
  const back = await anim(page, ".presenter .stage:not(.stage-leaving)");
  const backOld = await anim(page, ".presenter .stage-leaving");
  check("back: plays the push in the other direction", back.n === "dt-in-right" && backOld.n === "dt-out-right", JSON.stringify([back, backOld]));
  await sleep(800);
  check("back: ends on the first screen with one stage", (await crumb(page)) === "Motion A" && (await page.locator(".presenter .stage").count()) === 1);
}

// Slide plays as it always did: only the new screen moves, over nothing.
await hot(page, "Slide btn").click();
await sleep(150);
{
  const n = await page.locator(".presenter .stage").count();
  const a = await anim(page);
  check("slide: one screen, the new one slides in", n === 1 && a.n === "dt-in-left", JSON.stringify([n, a]));
  await sleep(700);
  await page.click(".presenter .bar button[title='Back']");
  await sleep(150);
  const b = await anim(page);
  check("slide: back comes from the other side", (await page.locator(".presenter .stage").count()) === 1 && b.n === "dt-in-right", JSON.stringify(b));
  await sleep(700);
}
await closePresent(page);

// In a small window the screens are scaled down; moving them must not change that.
await page.setViewportSize({ width: 1400, height: 700 });
await present(page, "Motion A");
await hot(page, "Push btn").click();
await sleep(250);
{
  const w = await page.locator(".presenter .stage").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  check("push in a small window: both screens are drawn at the same scale", w.length === 2 && w[0] === w[1] && w[0] < 700, JSON.stringify(w));
}
await sleep(700);
await closePresent(page);
await page.setViewportSize({ width: 1400, height: 1100 });

// The screen that is leaving keeps its scroll position while it goes.
await proto("Item", { action: "navigate", destinationId: "Detail", transition: "push", duration: 900 });
await present(page, "Feed");
{
  const sc = page.locator(`.presenter [data-scroller="${ids["Feed"]}"]`);
  const sb = await rectOf(sc);
  await page.mouse.move(sb.x + 200, sb.y + 700);
  await page.mouse.wheel(0, 600);
  await sleep(400);
  await hot(page, "Item").click();
  await sleep(250);
  const left = await page.locator(".presenter .stage-leaving [data-scroller]").first().evaluate((e) => e.scrollTop);
  check("leaving screen keeps its scroll position", near(left, 600, 2), `scrollTop ${left}`);
}
await proto("Item", { action: "navigate", destinationId: "Detail", transition: "instant" });
await closePresent(page);

// ---------- 10: smart animate ----------

{
  const d = await doc();
  const cardA = Object.values(d.nodes).find((n) => n.name === "Card" && n.parent === ids["Smart A"]);
  await tool("set_prototype", { nodeId: cardA.id, action: "navigate", destinationId: ids["Smart B"], transition: "smart_animate", duration: 1000, easing: "linear" });
  ids["Card A"] = cardA.id;
  await present(page, "Smart A");
  const stage = await rectOf(page.locator(".presenter .stage").first());
  await page.locator(`.presenter [data-hotspot="${cardA.id}"]`).click();
  await sleep(500);
  const piece = page.locator(".presenter [data-smart='Card']").first();
  check("smart animate: the matched layer is animated", (await page.locator(".presenter [data-smart='Card']").count()) >= 1);
  const pr = await rectOf(piece);
  const x = pr.x - stage.x;
  check("smart animate: mid-way the card is between its two positions", x > 40 && x < 180, `x=${x.toFixed(1)} (20 -> 200)`);
  const badge = await page.locator(".presenter [data-smart='Badge']").first().evaluate((e) => parseFloat(getComputedStyle(e).opacity));
  check("smart animate: a layer only in the destination fades in", badge > 0.05 && badge < 0.95, `opacity ${badge.toFixed(2)}`);
  await shot(page, "smart-mid");
  await sleep(900);
  check("smart animate: the real screen replaces the animation", (await page.locator(".presenter [data-smart]").count()) === 0 && (await crumb(page)) === "Smart B");
  await closePresent(page);
}

// ---------- later siblings of a carousel in a plain frame ----------

for (const [name, color] of [["Dots over", "fe0000"], ["Dots below", "fd0000"]]) {
  await present(page, "Zsec");
  const r = await rectOf(hot(page, name));
  const at = [r.x + r.width / 2, r.y + r.height / 2];
  const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute("data-hotspot"), at);
  const drawn = await page.evaluate(([x, y, c]) => document.elementsFromPoint(x, y).some((e) => e.tagName === "svg" && e.innerHTML.toLowerCase().includes(c)), [...at, color]);
  check(`${name}: drawn and on top, inside a plain frame`, top === ids[name] && drawn, `top ${top} drawn ${drawn}`);
  await hot(page, name).click();
  await sleep(150);
  check(`${name}: clicking it navigates`, (await crumb(page)) === "Detail", await crumb(page));
  await closePresent(page);
}

// ---------- Escape closes an open overlay and stops there ----------

await present(page, "Esc A");
await hot(page, "Esc open").click();
await sleep(300);
check("escape: the overlay is open", (await page.locator(".presenter .overlay-backdrop").count()) === 1);
await page.keyboard.press("Escape");
await sleep(200);
check("escape: closes the overlay and doesn't run the screen's Escape trigger", (await page.locator(".presenter .overlay-backdrop").count()) === 0 && (await crumb(page)) === "Esc A", await crumb(page));
await page.keyboard.press("Escape");
await sleep(200);
check("escape: with no overlay the screen's Escape trigger runs", (await crumb(page)) === "Detail", await crumb(page));
await closePresent(page);

// ---------- 11: the view link plays scrolling and the toggle too ----------

await proto("Next", { action: "navigate", destinationId: "Other", transition: "instant" });
await dispatch({ op: "setFlowStart", page: await page.evaluate(() => window.__dt.state().page), id: ids["Feed"] });
const link = await page.evaluate(async () => {
  const json = JSON.stringify({ v: 1, doc: window.__dt.doc(), assets: {} });
  const buf = await new Response(new Blob([new TextEncoder().encode(json)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
});
const view = await context.newPage();
watch(view);
await view.goto(URL + "/#/view/" + link);
await view.waitForSelector(".presenter", { timeout: 20000 });
await sleep(500);
check("view link: the player opens", (await view.locator(".presenter .remix").count()) === 1);
{
  // The viewer has no editor: find the screens by walking with the arrows.
  const scrollerEl = view.locator(`.presenter [data-scroller="${ids["Feed"]}"]`);
  check("view link: the feed is a scroller", (await scrollerEl.count()) === 1);
  const sbox = await rectOf(scrollerEl);
  const item0 = await rectOf(hot(view, "Item"));
  const nav0 = await rectOf(hot(view, "Nav"));
  await view.mouse.move(sbox.x + 200, sbox.y + 700);
  await view.mouse.wheel(0, 600);
  await sleep(400);
  const item1 = await rectOf(hot(view, "Item"));
  const nav1 = await rectOf(hot(view, "Nav"));
  check("view link: wheel scrolls the content and the nav stays", near(item1.y - item0.y, -600, 2) && near(nav1.y, nav0.y, 0.5));
  await hot(view, "Item").click();
  await sleep(150);
  check("view link: clicking after scrolling navigates", (await crumb(view)) === "Detail");
  // Walk to Settings with the next-frame arrow.
  for (let i = 0; i < 12 && (await crumb(view)) !== "Settings"; i++) {
    await view.keyboard.press("ArrowRight");
    await sleep(120);
  }
  check("view link: reached Settings", (await crumb(view)) === "Settings", await crumb(view));
  await sleep(500);
  const html = async () => (await view.locator(".presenter .stage:not(.stage-leaving)").first().innerHTML()).toLowerCase();
  check("view link: the toggle starts Off", (await html()).includes("ff0000"));
  await hot(view, "Toggle").click();
  await sleep(300);
  const h = await html();
  check("view link: click changes the variant and keeps the label", h.includes("00aa00") && h.includes("wi-fi"));
}

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
