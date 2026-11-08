import { afterEach, describe, expect, it, vi } from "vitest";
import { canFullscreen, exitFullscreenIfInside, isFullscreenIn, toggleFullscreen } from "./fullscreen";

/** A stand-in document: `enabled` is `fullscreenEnabled`, `request` the element method (undefined: no API). */
function stubDocument(opts: { enabled?: boolean; request?: (() => Promise<void>) | undefined; current?: unknown }) {
  const exit = vi.fn(async () => {
    doc.fullscreenElement = null;
  });
  const doc: Record<string, unknown> = {
    fullscreenEnabled: opts.enabled ?? true,
    fullscreenElement: opts.current ?? null,
    exitFullscreen: exit,
    documentElement: opts.request ? { requestFullscreen: opts.request } : {},
  };
  vi.stubGlobal("document", doc);
  return { doc, exit };
}

const el = (contains: (x: unknown) => boolean = () => false) => ({ contains, requestFullscreen: vi.fn(async () => {}) }) as unknown as Element;

afterEach(() => vi.unstubAllGlobals());

describe("canFullscreen", () => {
  it("needs the flag and the method", () => {
    stubDocument({ request: async () => {} });
    expect(canFullscreen()).toBe(true);
    stubDocument({ enabled: false, request: async () => {} });
    expect(canFullscreen()).toBe(false);
    stubDocument({});
    expect(canFullscreen()).toBe(false);
  });
});

describe("toggleFullscreen", () => {
  it("enters with the element", async () => {
    stubDocument({ request: async () => {} });
    const e = el();
    expect(await toggleFullscreen(e)).toBe(true);
    expect(e.requestFullscreen).toHaveBeenCalledOnce();
  });

  it("leaves when something is already in full screen", async () => {
    const inner = {};
    const { exit } = stubDocument({ request: async () => {}, current: inner });
    expect(await toggleFullscreen(el((x) => x === inner))).toBe(true);
    expect(exit).toHaveBeenCalledOnce();
  });

  it("leaves another element's full screen alone", async () => {
    const { exit } = stubDocument({ request: async () => {}, current: {} });
    expect(await toggleFullscreen(el())).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it("reports a refusal instead of throwing", async () => {
    stubDocument({ request: async () => {} });
    const e = el();
    (e.requestFullscreen as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("denied"));
    expect(await toggleFullscreen(e)).toBe(false);
    const sync = el();
    (sync.requestFullscreen as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("not allowed");
    });
    expect(await toggleFullscreen(sync)).toBe(false);
  });

  it("is false without the API or an element", async () => {
    stubDocument({});
    expect(await toggleFullscreen(el())).toBe(false);
    stubDocument({ request: async () => {} });
    expect(await toggleFullscreen(null)).toBe(false);
  });
});

describe("exitFullscreenIfInside", () => {
  it("leaves only when the element holds the full screen element", () => {
    const inner = {};
    const { exit } = stubDocument({ request: async () => {}, current: inner });
    exitFullscreenIfInside(el((x) => x === inner));
    expect(exit).toHaveBeenCalledOnce();
    expect(isFullscreenIn(el((x) => x === inner))).toBe(false);
  });

  it("does nothing for another element or no full screen", () => {
    const { exit } = stubDocument({ request: async () => {}, current: {} });
    exitFullscreenIfInside(el());
    exitFullscreenIfInside(null);
    stubDocument({ request: async () => {} });
    exitFullscreenIfInside(el(() => true));
    expect(exit).not.toHaveBeenCalled();
  });

  it("swallows a failing exit", () => {
    const inner = {};
    const { doc } = stubDocument({ request: async () => {}, current: inner });
    doc.exitFullscreen = () => {
      throw new Error("x");
    };
    expect(() => exitFullscreenIfInside(el((x) => x === inner))).not.toThrow();
  });
});
