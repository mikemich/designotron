// Stock photo providers. Pure: every request goes through the `fetch` the caller passes in, so
// tests run against fixtures. Openverse needs no key; Pexels takes the user's own key. The code is
// shaped so another provider (Unsplash) is one more entry in `PROVIDERS` plus a normaliser, but
// none is offered today (its guidelines ask for hotlinking, and we embed the bytes).

import type { ImageCredit } from "../types";

export type ProviderId = "openverse" | "pexels";
export type Orientation = "landscape" | "portrait" | "square";

export interface PhotoEnv {
  fetch: typeof fetch;
  /** The user's own keys, per provider (Openverse needs none). */
  keys: Partial<Record<ProviderId, string>>;
  /** Also list licences that forbid commercial use. */
  nonCommercial: boolean;
}

export interface SearchOptions {
  provider: ProviderId;
  query: string;
  orientation?: Orientation;
  /** Results per page, 1-20 (default 12). */
  count?: number;
  page?: number;
}

export interface PhotoResult {
  /** `openverse:<uuid>` or `pexels:<digits>`. */
  id: string;
  provider: ProviderId;
  thumb: string;
  /** What `download.ts` fetches (host-checked there). */
  downloadUrl: string;
  width: number;
  height: number;
  title: string;
  author: string;
  license: string;
  attributionRequired: boolean;
  nonCommercial: boolean;
  credit: ImageCredit;
}

export interface SearchPage {
  results: PhotoResult[];
  page: number;
  hasMore: boolean;
}

export type PhotoErrorKind = "rateLimited" | "offline" | "timeout" | "key" | "http" | "bad";

export class PhotoError extends Error {
  constructor(
    public kind: PhotoErrorKind,
    message: string,
    public extra: { retryAfter?: number; status?: number } = {},
  ) {
    super(message);
  }
}

export const PROVIDERS: Record<ProviderId, { label: string; apiHost: string; imageHosts: string[]; needsKey: boolean; site: string; siteLabel: string }> = {
  openverse: { label: "Openverse", apiHost: "api.openverse.org", imageHosts: ["api.openverse.org"], needsKey: false, site: "https://openverse.org/", siteLabel: "Openverse" },
  pexels: { label: "Pexels", apiHost: "api.pexels.com", imageHosts: ["images.pexels.com"], needsKey: true, site: "https://www.pexels.com/", siteLabel: "Pexels" },
};

const TIMEOUT_MS = 15000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_COUNT = 20;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OPENVERSE_ID = new RegExp(`^openverse:(${UUID})$`);
const PEXELS_ID = /^pexels:(\d{1,12})$/;
const ALLOWED = ["cc0", "pdm", "by", "by-sa"];
const ALLOWED_NC = [...ALLOWED, "by-nc", "by-nc-sa"];
const SEARCH_CACHE = 30;
const RESULT_CACHE = 200;

// ---------- Public API ----------

export async function searchPhotos(env: PhotoEnv, o: SearchOptions): Promise<SearchPage> {
  const query = o.query.trim().slice(0, 200);
  if (!query) throw new PhotoError("bad", "Type what the photo should show");
  const count = Math.max(1, Math.min(MAX_COUNT, Math.round(o.count ?? 12)));
  const page = Math.max(1, Math.round(o.page ?? 1));
  const key = [o.provider, query.toLowerCase(), o.orientation ?? "", count, page, env.nonCommercial ? "nc" : "c"].join("|");
  const hit = searches.get(key);
  if (hit) {
    searches.delete(key);
    searches.set(key, hit);
    return hit;
  }
  const out = o.provider === "pexels" ? await searchPexels(env, query, o.orientation, count, page) : await searchOpenverse(env, query, o.orientation, count, page);
  remember(key, out);
  return out;
}

/** Looks a photo up by its id (never by a URL Claude made up). */
export async function photoDetails(env: PhotoEnv, id: string): Promise<PhotoResult> {
  const cached = results.get(id);
  // A non-commercial photo found with the toggle on isn't handed out once it is off.
  if (cached && (!cached.nonCommercial || env.nonCommercial)) return cached;
  if (cached) throw new PhotoError("bad", "That photo can't be used (its licence isn't allowed)");
  const parsed = parsePhotoId(id);
  if (!parsed) throw new PhotoError("bad", `'${String(id).slice(0, 60)}' is not a photo id from search_photos`);
  let r: PhotoResult | null;
  if (parsed.provider === "pexels") {
    const json = await apiJson(env, "pexels", `https://api.pexels.com/v1/photos/${parsed.raw}`);
    r = pexelsResult(json);
  } else {
    const json = await apiJson(env, "openverse", `https://api.openverse.org/v1/images/${parsed.raw}/`);
    r = openverseResult(json, env.nonCommercial);
  }
  if (!r) throw new PhotoError("bad", "That photo can't be used (its licence or source isn't allowed)");
  rememberResult(r);
  return r;
}

export function parsePhotoId(id: unknown): { provider: ProviderId; raw: string } | null {
  if (typeof id !== "string") return null;
  const o = OPENVERSE_ID.exec(id);
  if (o) return { provider: "openverse", raw: o[1] };
  const p = PEXELS_ID.exec(id);
  if (p) return { provider: "pexels", raw: p[1] };
  return null;
}

/** An Openverse or Pexels photo page URL as a photo id. */
export function photoIdFromUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./, "");
  if (host === "openverse.org") {
    const m = new RegExp(`^/image/(${UUID})/?$`).exec(u.pathname);
    return m ? `openverse:${m[1]}` : null;
  }
  if (host === "pexels.com") {
    const m = /^\/photo\/(?:[a-z0-9-]*-)?(\d{1,12})\/?$/.exec(u.pathname);
    return m ? `pexels:${m[1]}` : null;
  }
  return null;
}

/** Results of recent searches are kept so placing a photo needs no second request. */
export function clearPhotoCache() {
  searches.clear();
  results.clear();
}

/** An https link with credentials, port, query and fragment removed; "" when it isn't one. */
export function safeLink(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || u.username || u.password || u.port) return "";
    return u.origin + u.pathname;
  } catch {
    return "";
  }
}

/** Free text from a provider as one short plain line (no control characters). */
export function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// ---------- Openverse ----------

async function searchOpenverse(env: PhotoEnv, query: string, orientation: Orientation | undefined, count: number, page: number): Promise<SearchPage> {
  const u = new URL("https://api.openverse.org/v1/images/");
  u.searchParams.set("q", query);
  u.searchParams.set("page_size", String(count));
  u.searchParams.set("page", String(page));
  u.searchParams.set("mature", "false");
  u.searchParams.set("category", "photograph");
  // Commercial use and changes allowed: cc0, pdm, by, by-sa. The toggle adds the by-nc family.
  if (env.nonCommercial) u.searchParams.set("license", "cc0,pdm,by,by-sa,by-nc,by-nc-sa");
  else u.searchParams.set("license_type", "commercial,modification");
  if (orientation) u.searchParams.set("aspect_ratio", { landscape: "wide", portrait: "tall", square: "square" }[orientation]);
  const json = await apiJson(env, "openverse", u.href);
  const list = Array.isArray(json?.results) ? json.results : [];
  const out = list.map((x: any) => openverseResult(x, env.nonCommercial)).filter((x: PhotoResult | null): x is PhotoResult => !!x);
  const pages = Number(json?.page_count);
  return { results: out, page, hasMore: Number.isFinite(pages) ? page < pages : list.length >= count };
}

function openverseResult(x: any, nonCommercialOk: boolean): PhotoResult | null {
  const uuid = typeof x?.id === "string" && new RegExp(`^${UUID}$`).test(x.id) ? x.id : "";
  const code = typeof x?.license === "string" ? x.license.toLowerCase() : "";
  if (!uuid) return null;
  // Only these licences allow commercial use and changes (the toggle adds the NC ones).
  if (!(nonCommercialOk ? ALLOWED_NC : ALLOWED).includes(code)) return null;
  const nonCommercial = code.includes("nc");
  const version = cleanText(x.license_version, 8);
  const license = code === "cc0" ? `CC0 ${version || "1.0"}` : code === "pdm" ? `Public Domain Mark ${version || "1.0"}` : `CC ${code.toUpperCase()}${version ? " " + version : ""}`;
  const fallbackLicenseUrl = code === "cc0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : code === "pdm" ? "https://creativecommons.org/publicdomain/mark/1.0/" : version ? `https://creativecommons.org/licenses/${code}/${version}/` : "";
  const title = cleanText(x.title, 120) || "Untitled";
  const author = cleanText(x.creator, 80);
  const provider = cleanText(x.provider ?? x.source, 40);
  const credit: ImageCredit = {
    provider: "openverse",
    photoId: `openverse:${uuid}`,
    title,
    alt: title === "Untitled" ? "" : title,
    author,
    authorUrl: safeLink(x.creator_url),
    source: provider ? `${titleCase(provider)} via Openverse` : "Openverse",
    sourceUrl: safeLink(x.foreign_landing_url),
    license,
    licenseUrl: safeLink(x.license_url) || fallbackLicenseUrl,
    attributionRequired: code.startsWith("by"),
    nonCommercial,
  };
  return {
    id: credit.photoId,
    provider: "openverse",
    thumb: `https://api.openverse.org/v1/images/${uuid}/thumb/`,
    downloadUrl: `https://api.openverse.org/v1/images/${uuid}/thumb/?full_size=true&compressed=true`,
    width: dimension(x.width),
    height: dimension(x.height),
    title,
    author,
    license,
    attributionRequired: credit.attributionRequired,
    nonCommercial,
    credit,
  };
}

// ---------- Pexels ----------

async function searchPexels(env: PhotoEnv, query: string, orientation: Orientation | undefined, count: number, page: number): Promise<SearchPage> {
  const u = new URL("https://api.pexels.com/v1/search");
  u.searchParams.set("query", query);
  u.searchParams.set("per_page", String(count));
  u.searchParams.set("page", String(page));
  if (orientation) u.searchParams.set("orientation", orientation);
  const json = await apiJson(env, "pexels", u.href);
  const list = Array.isArray(json?.photos) ? json.photos : [];
  const out = list.map(pexelsResult).filter((x: PhotoResult | null): x is PhotoResult => !!x);
  return { results: out, page, hasMore: typeof json?.next_page === "string" };
}

function pexelsResult(x: any): PhotoResult | null {
  const digits = Number.isInteger(x?.id) && x.id > 0 ? String(x.id) : typeof x?.id === "string" && /^\d{1,12}$/.test(x.id) ? x.id : "";
  if (!digits) return null;
  const hosts = PROVIDERS.pexels.imageHosts;
  const thumb = hostedUrl(x?.src?.medium ?? x?.src?.large, hosts);
  const original = hostedUrl(x?.src?.original, hosts);
  if (!thumb || !original) return null;
  const dl = new URL(original);
  dl.search = "";
  dl.searchParams.set("auto", "compress");
  dl.searchParams.set("cs", "tinysrgb");
  dl.searchParams.set("w", "1600");
  const author = cleanText(x.photographer, 80);
  const alt = cleanText(x.alt, 200);
  const title = alt ? cleanText(alt, 120) : author ? `Photo by ${author}` : "Pexels photo";
  const credit: ImageCredit = {
    provider: "pexels",
    photoId: `pexels:${digits}`,
    title,
    alt,
    author,
    authorUrl: safeLink(x.photographer_url),
    source: "Pexels",
    sourceUrl: safeLink(x.url),
    license: "Pexels License",
    licenseUrl: "https://www.pexels.com/license/",
    attributionRequired: false,
    nonCommercial: false,
  };
  return {
    id: credit.photoId,
    provider: "pexels",
    thumb,
    downloadUrl: dl.href,
    width: dimension(x.width),
    height: dimension(x.height),
    title,
    author,
    license: credit.license,
    attributionRequired: false,
    nonCommercial: false,
    credit,
  };
}

// ---------- Requests ----------

/** One JSON GET to a provider's API host (exact host, https, no redirects, size and time caps). */
async function apiJson(env: PhotoEnv, provider: ProviderId, url: string): Promise<any> {
  const spec = PROVIDERS[provider];
  assertHost(url, [spec.apiHost]);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (spec.needsKey) {
    const key = env.keys[provider]?.trim();
    if (!key) throw new PhotoError("key", `Add your ${spec.label} key under Sources and keys`);
    headers.Authorization = key;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await env.fetch(url, { headers, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: ctl.signal });
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") throw new PhotoError("timeout", `${spec.label} took too long to answer`);
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw new PhotoError("offline", "Photo search needs the internet");
      throw new PhotoError("http", `Couldn't reach ${spec.label}`);
    }
    if (res.status === 429) throw new PhotoError("rateLimited", `${spec.label} is rate limiting searches`, { retryAfter: retryAfter(res), status: 429 });
    if (res.status === 401 || res.status === 403) {
      if (spec.needsKey) throw new PhotoError("key", `${spec.label} refused the key`, { status: res.status });
      throw new PhotoError("rateLimited", `${spec.label} refused the request (rate limit)`, { retryAfter: retryAfter(res), status: res.status });
    }
    if (res.status === 404) throw new PhotoError("bad", "Photo not found", { status: 404 });
    if (!res.ok) throw new PhotoError("http", `${spec.label} isn't answering right now. Try again in a moment.`, { status: res.status });
    const text = await readCapped(res, MAX_JSON_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw new PhotoError("http", `${spec.label} sent an answer Designotron couldn't read. Try again in a moment.`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function retryAfter(res: Response): number | undefined {
  const n = Number(res.headers.get("retry-after"));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 3600) : undefined;
}

async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) throw new PhotoError("http", "The answer is too big");
  const text = await res.text();
  if (text.length > max) throw new PhotoError("http", "The answer is too big");
  return text;
}

/** Throws unless `url` is https, has no credentials or port and its host is one of `hosts` exactly. */
export function assertHost(url: string, hosts: string[]): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PhotoError("bad", "Not a valid address");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !hosts.includes(u.hostname)) {
    throw new PhotoError("bad", `Refusing to load from ${u.hostname || "that address"}`);
  }
  return u;
}

function hostedUrl(raw: unknown, hosts: string[]): string {
  if (typeof raw !== "string") return "";
  try {
    return assertHost(raw, hosts).href;
  } catch {
    return "";
  }
}

// ---------- Small helpers and the session cache ----------

const searches = new Map<string, SearchPage>();
const results = new Map<string, PhotoResult>();

function remember(key: string, page: SearchPage) {
  searches.set(key, page);
  if (searches.size > SEARCH_CACHE) searches.delete(searches.keys().next().value as string);
  for (const r of page.results) rememberResult(r);
}

function rememberResult(r: PhotoResult) {
  results.delete(r.id);
  results.set(r.id, r);
  if (results.size > RESULT_CACHE) results.delete(results.keys().next().value as string);
}

function dimension(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n) : 0;
}

function titleCase(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
