// Presenter options remembered per browser. Storage can be missing or throw (private windows,
// blocked site data), so every read and write is guarded and falls back to the defaults.

const HINTS = "dt:present-hints";
const ALWAYS = "dt:present-always";

export interface PresenterPrefs {
  /** Flash the clickable areas when a click lands on nothing (default on). */
  hints: boolean;
  /** Outline every hotspot all the time (default off). */
  always: boolean;
}

export const DEFAULT_PREFS: PresenterPrefs = { hints: true, always: false };

function read(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === "1" ? true : v === "0" ? false : fallback;
  } catch {
    return fallback;
  }
}

export function loadPrefs(): PresenterPrefs {
  return { hints: read(HINTS, DEFAULT_PREFS.hints), always: read(ALWAYS, DEFAULT_PREFS.always) };
}

/** Saves what changed. A value equal to its default is stored too, so a later change of the default doesn't move it. */
export function savePrefs(p: Partial<PresenterPrefs>) {
  try {
    if (p.hints !== undefined) localStorage.setItem(HINTS, p.hints ? "1" : "0");
    if (p.always !== undefined) localStorage.setItem(ALWAYS, p.always ? "1" : "0");
  } catch {
    /* not remembered */
  }
}
