import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { fetchImageBytes, MAX_IMAGE_BYTES, sniff } from "./download";
import {
  assertHost,
  clearPhotoCache,
  parsePhotoId,
  PhotoError,
  photoDetails,
  photoIdFromUrl,
  safeLink,
  searchPhotos,
  type PhotoEnv,
} from "./providers";

const FIX = new URL("../../scripts/fixtures/photos/", import.meta.url);
const text = (f: string) => readFileSync(new URL(f, FIX), "utf8");
const bytes = (f: string) => new Uint8Array(readFileSync(new URL(f, FIX)));
const U1 = "00000001-aaaa-4bbb-8ccc-dddddddddddd";

interface Call {
  url: string;
  init?: RequestInit;
}

/** A fetch that answers from `routes` (first matching prefix) and records every call. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fn = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const hit = Object.keys(routes).find((p) => url.startsWith(p));
    if (!hit) throw new TypeError("no route " + url);
    return routes[hit]();
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: string, status = 200, headers: Record<string, string> = {}) => () => new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
const env = (f: typeof fetch, over: Partial<PhotoEnv> = {}): PhotoEnv => ({ fetch: f, keys: {}, nonCommercial: false, ...over });

beforeEach(() => clearPhotoCache());

describe("Openverse search", () => {
  it("asks for safe, commercial-safe photographs and maps orientation", async () => {
    const { fn, calls } = fakeFetch({ "https://api.openverse.org/v1/images/": json(text("openverse-search.json")) });
    await searchPhotos(env(fn), { provider: "openverse", query: "white sneakers", orientation: "landscape", count: 6 });
    const u = new URL(calls[0].url);
    expect(u.hostname).toBe("api.openverse.org");
    expect(u.searchParams.get("q")).toBe("white sneakers");
    expect(u.searchParams.get("mature")).toBe("false");
    expect(u.searchParams.get("category")).toBe("photograph");
    expect(u.searchParams.get("license_type")).toBe("commercial,modification");
    expect(u.searchParams.get("license")).toBeNull();
    expect(u.searchParams.get("aspect_ratio")).toBe("wide");
    expect(u.searchParams.get("page_size")).toBe("6");
    expect(calls[0].init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("normalises results and credits", async () => {
    const { fn } = fakeFetch({ "https://api.openverse.org/": json(text("openverse-search.json")) });
    const page = await searchPhotos(env(fn), { provider: "openverse", query: "shoes" });
    expect(page.results).toHaveLength(6);
    const r = page.results[0];
    expect(r).toMatchObject({ id: `openverse:${U1}`, title: "White sneakers on concrete", author: "Ann Lee", license: "CC BY 2.0", attributionRequired: true, nonCommercial: false, width: 640, height: 480 });
    expect(r.thumb).toBe(`https://api.openverse.org/v1/images/${U1}/thumb/`);
    expect(r.downloadUrl).toContain("full_size=true");
    // Credit links lose their query and fragment.
    expect(r.credit.sourceUrl).toBe("https://www.flickr.com/photos/example/100");
    expect(r.credit.source).toBe("Flickr via Openverse");
    expect(r.credit.licenseUrl).toBe("https://creativecommons.org/licenses/by/2.0/");
    expect(page.results[2]).toMatchObject({ license: "CC0 1.0", attributionRequired: false });
    expect(page.results[3].license).toBe("Public Domain Mark 1.0");
    expect(page.hasMore).toBe(false);
  });

  it("the non-commercial toggle switches the licence filter and badges those results; ND is always dropped", async () => {
    const { fn, calls } = fakeFetch({ "https://api.openverse.org/": json(text("openverse-search-nc.json")) });
    const page = await searchPhotos(env(fn, { nonCommercial: true }), { provider: "openverse", query: "shoes" });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get("license")).toBe("cc0,pdm,by,by-sa,by-nc,by-nc-sa");
    expect(u.searchParams.get("license_type")).toBeNull();
    const nc = page.results.find((r) => r.nonCommercial);
    expect(nc?.license).toBe("CC BY-NC 2.0");
    expect(page.results.some((r) => r.license.includes("ND"))).toBe(false);
    // Without the toggle, an NC result the server sent anyway is dropped too.
    clearPhotoCache();
    const plain = await searchPhotos(env(fn), { provider: "openverse", query: "shoes" });
    expect(plain.results.some((r) => r.nonCommercial)).toBe(false);
    expect(plain.results).toHaveLength(6);
  });

  it("caches searches and results for placing", async () => {
    const { fn, calls } = fakeFetch({ "https://api.openverse.org/v1/images/?": json(text("openverse-search.json")) });
    await searchPhotos(env(fn), { provider: "openverse", query: "shoes" });
    await searchPhotos(env(fn), { provider: "openverse", query: "SHOES " });
    expect(calls).toHaveLength(1);
    const r = await photoDetails(env(fn), `openverse:${U1}`);
    expect(r.author).toBe("Ann Lee");
    expect(calls).toHaveLength(1);
  });

  it("looks a photo up by id when it isn't cached", async () => {
    const { fn, calls } = fakeFetch({ [`https://api.openverse.org/v1/images/${U1}/`]: json(text("openverse-detail.json")) });
    const r = await photoDetails(env(fn), `openverse:${U1}`);
    expect(r.title).toBe("White sneakers on concrete");
    expect(calls[0].url).toBe(`https://api.openverse.org/v1/images/${U1}/`);
  });
});

describe("Pexels", () => {
  it("needs a key and sends it only to api.pexels.com", async () => {
    const { fn, calls } = fakeFetch({ "https://api.pexels.com/": json(text("pexels-search.json")) });
    await expect(searchPhotos(env(fn), { provider: "pexels", query: "shoes" })).rejects.toMatchObject({ kind: "key" });
    expect(calls).toHaveLength(0);
    const page = await searchPhotos(env(fn, { keys: { pexels: "SECRET" } }), { provider: "pexels", query: "shoes", orientation: "portrait" });
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("SECRET");
    expect(new URL(calls[0].url).searchParams.get("orientation")).toBe("portrait");
    expect(JSON.stringify(page)).not.toContain("SECRET");
    expect(page.results[0]).toMatchObject({ id: "pexels:1001", license: "Pexels License", author: "Pia Park", attributionRequired: false });
    expect(page.results[0].downloadUrl).toContain("w=1600");
    expect(page.results[0].credit.licenseUrl).toBe("https://www.pexels.com/license/");
    // A photo without alt text is titled from its author.
    expect(page.results[3].title).toBe("Photo by Sol Vega");
  });

  it("drops results whose images are on other hosts", async () => {
    const evil = JSON.parse(text("pexels-search.json"));
    evil.photos[0].src.original = "https://images.pexels.com.evil.example/x.jpg";
    const { fn } = fakeFetch({ "https://api.pexels.com/": json(JSON.stringify(evil)) });
    const page = await searchPhotos(env(fn, { keys: { pexels: "k" } }), { provider: "pexels", query: "shoes" });
    expect(page.results.map((r) => r.id)).not.toContain("pexels:1001");
    expect(page.results).toHaveLength(3);
  });

  it("a refused key says so", async () => {
    const { fn } = fakeFetch({ "https://api.pexels.com/": json("{}", 401) });
    await expect(searchPhotos(env(fn, { keys: { pexels: "bad" } }), { provider: "pexels", query: "x" })).rejects.toMatchObject({ kind: "key" });
  });
});

describe("errors", () => {
  it("429 becomes rateLimited with the wait", async () => {
    const { fn } = fakeFetch({ "https://api.openverse.org/": json("{}", 429, { "retry-after": "42" }) });
    const err = await searchPhotos(env(fn), { provider: "openverse", query: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(PhotoError);
    expect(err).toMatchObject({ kind: "rateLimited", extra: { retryAfter: 42 } });
  });

  it("a server error and a network failure are reported", async () => {
    const a = fakeFetch({ "https://api.openverse.org/": json("{}", 500) });
    await expect(searchPhotos(env(a.fn), { provider: "openverse", query: "x" })).rejects.toMatchObject({ kind: "http" });
    const b = fakeFetch({});
    await expect(searchPhotos(env(b.fn), { provider: "openverse", query: "y" })).rejects.toBeInstanceOf(PhotoError);
  });

  it("an oversized JSON answer is refused", async () => {
    const big = "[" + "0,".repeat(1.2 * 1024 * 1024) + "0]";
    const { fn } = fakeFetch({ "https://api.openverse.org/": json(big) });
    await expect(searchPhotos(env(fn), { provider: "openverse", query: "big" })).rejects.toMatchObject({ kind: "http" });
  });

  it("an empty query is refused without a request", async () => {
    const { fn, calls } = fakeFetch({});
    await expect(searchPhotos(env(fn), { provider: "openverse", query: "  " })).rejects.toMatchObject({ kind: "bad" });
    expect(calls).toHaveLength(0);
  });
});

describe("ids and links", () => {
  it("accepts only well-formed ids", () => {
    expect(parsePhotoId(`openverse:${U1}`)).toEqual({ provider: "openverse", raw: U1 });
    expect(parsePhotoId("pexels:123")).toEqual({ provider: "pexels", raw: "123" });
    for (const bad of ["openverse:../../etc", "openverse:" + U1 + "/x", "pexels:12a", "pexels:", "unsplash:abc", "https://evil.example/x.jpg", 5, null]) expect(parsePhotoId(bad)).toBeNull();
  });

  it("maps provider page URLs to ids", () => {
    expect(photoIdFromUrl(`https://openverse.org/image/${U1}`)).toBe(`openverse:${U1}`);
    expect(photoIdFromUrl(`https://www.openverse.org/image/${U1}/?q=x`)).toBe(`openverse:${U1}`);
    expect(photoIdFromUrl("https://www.pexels.com/photo/studio-sneakers-1001/")).toBe("pexels:1001");
    expect(photoIdFromUrl("https://www.pexels.com/photo/1001/")).toBe("pexels:1001");
    expect(photoIdFromUrl("http://www.pexels.com/photo/studio-1001/")).toBeNull();
    expect(photoIdFromUrl("https://pexels.com.evil.example/photo/a-1/")).toBeNull();
    expect(photoIdFromUrl("not a url")).toBeNull();
  });

  it("an invalid id is rejected before any request", async () => {
    const { fn, calls } = fakeFetch({});
    await expect(photoDetails(env(fn), "openverse:../x")).rejects.toMatchObject({ kind: "bad" });
    expect(calls).toHaveLength(0);
  });

  it("safeLink keeps only plain https links", () => {
    expect(safeLink("https://example.com/a/b?utm=1#x")).toBe("https://example.com/a/b");
    for (const bad of ["http://example.com/", "https://user:pw@example.com/", "https://example.com:8443/", "javascript:alert(1)", "data:text/html,x", "", 4]) expect(safeLink(bad)).toBe("");
  });
});

describe("host checks", () => {
  const hosts = ["api.openverse.org"];
  it("accepts the exact https host", () => {
    expect(assertHost("https://api.openverse.org/v1/images/x/thumb/", hosts).hostname).toBe("api.openverse.org");
  });
  it("rejects http, look-alike hosts, userinfo, ports and garbage", () => {
    for (const bad of ["http://api.openverse.org/x", "https://api.openverse.org.evil.com/x", "https://evil.com/api.openverse.org", "https://user@api.openverse.org/x", "https://api.openverse.org:444/x", "https://API.openverse.org.evil/x", "nope", "file:///etc/passwd", "data:image/png;base64,AA=="]) {
      expect(() => assertHost(bad, hosts), bad).toThrow(PhotoError);
    }
  });
});

describe("image downloads", () => {
  const hosts = ["api.openverse.org"];
  const url = `https://api.openverse.org/v1/images/${U1}/thumb/`;
  const image = (f: string, type: string, extra: Record<string, string> = {}) => () => new Response(bytes(f), { headers: { "content-type": type, ...extra } });

  it("accepts a JPEG and a PNG", async () => {
    const jpg = await fetchImageBytes(fakeFetch({ [url]: image("photo-1.jpg", "image/jpeg") }).fn, url, hosts);
    expect(jpg.kind).toBe("jpeg");
    const png = await fetchImageBytes(fakeFetch({ [url]: image("tiny.png", "image/png; charset=binary") }).fn, url, hosts);
    expect(png.kind).toBe("png");
  });

  it("refuses SVG, by header and when disguised as a JPEG", async () => {
    await expect(fetchImageBytes(fakeFetch({ [url]: image("evil.svg", "image/svg+xml") }).fn, url, hosts)).rejects.toMatchObject({ kind: "bad" });
    await expect(fetchImageBytes(fakeFetch({ [url]: image("evil.svg", "image/jpeg") }).fn, url, hosts)).rejects.toThrow(/isn't the image type/);
    await expect(fetchImageBytes(fakeFetch({ [url]: image("tiny.png", "image/jpeg") }).fn, url, hosts)).rejects.toThrow(/isn't the image type/);
    await expect(fetchImageBytes(fakeFetch({ [url]: image("photo-1.jpg", "text/html") }).fn, url, hosts)).rejects.toMatchObject({ kind: "bad" });
  });

  it("stops at the size cap, by header and while streaming", async () => {
    const body = new Uint8Array(MAX_IMAGE_BYTES + 10);
    body.set([0xff, 0xd8, 0xff]);
    await expect(fetchImageBytes(fakeFetch({ [url]: () => new Response(body, { headers: { "content-type": "image/jpeg" } }) }).fn, url, hosts)).rejects.toThrow(/too large/);
    await expect(
      fetchImageBytes(fakeFetch({ [url]: image("photo-1.jpg", "image/jpeg", { "content-length": String(MAX_IMAGE_BYTES + 1) }) }).fn, url, hosts),
    ).rejects.toThrow(/too large/);
  });

  it("refuses other hosts, before and after a redirect", async () => {
    const { fn, calls } = fakeFetch({});
    await expect(fetchImageBytes(fn, "https://live.staticflickr.com/x.jpg", hosts)).rejects.toMatchObject({ kind: "bad" });
    expect(calls).toHaveLength(0);
    const redirected = (async () => Object.defineProperty(new Response(bytes("photo-1.jpg"), { headers: { "content-type": "image/jpeg" } }), "url", { value: "https://evil.example/x.jpg" })) as unknown as typeof fetch;
    await expect(fetchImageBytes(redirected, url, hosts)).rejects.toMatchObject({ kind: "bad" });
  });

  it("maps 429 and errors", async () => {
    await expect(fetchImageBytes(fakeFetch({ [url]: () => new Response("", { status: 429 }) }).fn, url, hosts)).rejects.toMatchObject({ kind: "rateLimited" });
    await expect(fetchImageBytes(fakeFetch({ [url]: () => new Response("", { status: 404 }) }).fn, url, hosts)).rejects.toMatchObject({ kind: "http" });
  });

  it("sniffs magic bytes", () => {
    expect(sniff(bytes("photo-1.jpg"))).toBe("jpeg");
    expect(sniff(bytes("tiny.png"))).toBe("png");
    expect(sniff(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniff(bytes("evil.svg"))).toBeNull();
    expect(sniff(new Uint8Array())).toBeNull();
  });
});
