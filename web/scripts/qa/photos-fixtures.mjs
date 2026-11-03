// Playwright routes that stand in for the photo providers (Openverse, Pexels) so tests never touch
// the internet. Everything else off this machine is aborted and recorded.
//
//   const fx = await installPhotoFixtures(context);
//   fx.requests   every request that left the page for a non-local host: { host, url, method, auth }
//   fx.offHost    the ones that were not a fixture host
//   fx.state      switches: { boom: true } makes the next "boom" searches answer 500
//
// Queries steer the answers: "empty" (no results), "boom" (500 while state.boom), "limited"
// (429, retry-after 30), "svg" (a result whose image is an SVG), "huge" (a 16 MB image).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/photos");
const file = (f) => fs.readFileSync(path.join(DIR, f));
const json = (f) => JSON.parse(file(f).toString("utf8"));

export const PEXELS_KEY = "test-pexels-key-123";
export const FIXTURE_HOSTS = ["api.openverse.org", "api.pexels.com", "images.pexels.com"];
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "retry-after" };
const UUID_IMAGE = { 1: "photo-1.jpg", 2: "photo-2.jpg", 3: "photo-3.jpg", 4: "photo-4.jpg", 5: "portrait.jpg", 6: "square.jpg", 7: "tiny.jpg" };
const PEXELS_IMAGE = { 1001: "photo-1.jpg", 1002: "photo-2.jpg", 1003: "photo-3.jpg", 1004: "portrait.jpg" };
const uid = (c) => `0000000${c}-aaaa-4bbb-8ccc-dddddddddddd`;

export async function installPhotoFixtures(context) {
  const fx = { requests: [], offHost: [], state: { boom: true }, counts: { search: 0, thumb: 0 } };
  const local = (u) => /^(https?:\/\/(localhost|127\.0\.0\.1)[:/])|^(data|blob):/.test(u);

  context.on("request", (r) => {
    const u = r.url();
    if (local(u)) return;
    const host = new URL(u).hostname;
    const entry = { host, url: u, method: r.method(), auth: r.headers()["authorization"] };
    fx.requests.push(entry);
    if (!FIXTURE_HOSTS.includes(host)) fx.offHost.push(entry);
  });

  // Registered first, so it runs last: anything the fixtures don't answer is refused.
  await context.route(
    (u) => !local(u.toString()),
    (r) => r.abort(),
  );

  const preflight = (r) => r.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "authorization,accept", "access-control-allow-methods": "GET" } });
  const send = (r, body, status = 200, type = "application/json", extra = {}) => r.fulfill({ status, body, headers: { ...CORS, "content-type": type, ...extra } });

  await context.route(/^https:\/\/api\.openverse\.org\/v1\/images\/\?/, (r) => {
    if (r.request().method() === "OPTIONS") return preflight(r);
    fx.counts.search++;
    const u = new URL(r.request().url());
    const q = (u.searchParams.get("q") ?? "").toLowerCase();
    if (q.includes("empty")) return send(r, JSON.stringify({ result_count: 0, page_count: 0, page_size: 20, page: 1, results: [] }));
    if (q.includes("boom") && fx.state.boom) return send(r, "{}", 500);
    if (q.includes("limited")) return send(r, "{}", 429, "application/json", { "retry-after": "30" });
    const nc = (u.searchParams.get("license") ?? "").includes("by-nc");
    const body = json(nc ? "openverse-search-nc.json" : "openverse-search.json");
    if (q.includes("svg")) body.results = [{ ...body.results[0], id: uid("e"), title: "Vector drawing" }];
    if (q.includes("huge")) body.results = [{ ...body.results[0], id: uid("f"), title: "Gigantic photo" }];
    return send(r, JSON.stringify(body));
  });

  await context.route(/^https:\/\/api\.openverse\.org\/v1\/images\/[0-9a-f-]{36}\/thumb\//, (r) => {
    if (r.request().method() === "OPTIONS") return preflight(r);
    fx.counts.thumb++;
    const id = r.request().url().match(/images\/0000000(.)/)?.[1] ?? "1";
    if (id === "e") return send(r, file("evil.svg"), 200, "image/svg+xml");
    if (id === "f") {
      const big = Buffer.alloc(16 * 1024 * 1024 + 1024);
      big.set([0xff, 0xd8, 0xff]);
      // The thumbnail in the grid is small; only the full-size download is huge.
      return /full_size/.test(r.request().url()) ? send(r, big, 200, "image/jpeg") : send(r, file("photo-1.jpg"), 200, "image/jpeg");
    }
    // The grid thumbnail and the full-size download are the same fixture image.
    return send(r, file(UUID_IMAGE[id] ?? "photo-1.jpg"), 200, "image/jpeg");
  });

  await context.route(/^https:\/\/api\.openverse\.org\/v1\/images\/[0-9a-f-]{36}\/$/, (r) => {
    if (r.request().method() === "OPTIONS") return preflight(r);
    const id = r.request().url().match(/images\/([0-9a-f-]{36})\//)[1];
    return send(r, JSON.stringify({ ...json("openverse-detail.json"), id }));
  });

  await context.route(/^https:\/\/api\.pexels\.com\//, (r) => {
    const req = r.request();
    if (req.method() === "OPTIONS") return preflight(r);
    if (req.headers()["authorization"] !== PEXELS_KEY) return send(r, "{}", 401);
    if (/\/v1\/photos\/\d+/.test(req.url())) return send(r, JSON.stringify(json("pexels-detail.json")));
    return send(r, JSON.stringify(json("pexels-search.json")));
  });

  await context.route(/^https:\/\/images\.pexels\.com\/photos\/\d+\//, (r) => {
    const id = r.request().url().match(/photos\/(\d+)\//)[1];
    return send(r, file(PEXELS_IMAGE[id] ?? "photo-1.jpg"), 200, "image/jpeg");
  });

  return fx;
}
