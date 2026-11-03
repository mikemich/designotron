// Per-viewer photo settings. Keys stay in this browser's localStorage and are only ever sent in
// the Authorization header to their own provider's API host (see providers.ts).

import { PROVIDERS, type PhotoEnv, type ProviderId } from "./providers";

const KEY_PEXELS = "dt:photos:pexelsKey";
const KEY_NC = "dt:photos:nc";
const KEY_PROVIDER = "dt:photos:provider";

export function getKey(provider: ProviderId): string {
  return provider === "pexels" ? read(KEY_PEXELS) : "";
}

export function setKey(provider: ProviderId, key: string) {
  if (provider === "pexels") write(KEY_PEXELS, key.trim());
}

export function getNonCommercial(): boolean {
  return read(KEY_NC) === "1";
}

export function setNonCommercial(on: boolean) {
  write(KEY_NC, on ? "1" : "");
}

/** The provider the panel searches: the saved choice, Openverse when that one needs a key that isn't there. */
export function getProvider(): ProviderId {
  const saved = read(KEY_PROVIDER) as ProviderId;
  return Object.prototype.hasOwnProperty.call(PROVIDERS, saved) && (!PROVIDERS[saved].needsKey || getKey(saved)) ? saved : "openverse";
}

export function setProvider(p: ProviderId) {
  write(KEY_PROVIDER, p);
}

/** Providers the person can search right now. */
export function availableProviders(): ProviderId[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => !PROVIDERS[p].needsKey || getKey(p));
}

export function photoEnv(): PhotoEnv {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    keys: { pexels: getKey("pexels") },
    nonCommercial: getNonCommercial(),
  };
}

/** What this tab was told when storage is blocked. */
const memory = new Map<string, string>();

function read(k: string): string {
  try {
    return localStorage.getItem(k) ?? memory.get(k) ?? "";
  } catch {
    return memory.get(k) ?? "";
  }
}

function write(k: string, v: string) {
  if (v) memory.set(k, v);
  else memory.delete(k);
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* storage blocked: the setting lasts until reload only */
  }
}
