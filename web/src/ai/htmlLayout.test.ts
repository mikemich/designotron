import { describe, expect, it } from "vitest";
import { DEFAULT_CSS, emitSpec, planContainer, planTree, simulate, type BoxNode, type Css } from "./htmlLayout";

const text = (x: number, y: number, w: number, h: number, css: Partial<Css> = {}): BoxNode => ({
  kind: "text",
  rect: { x, y, w, h },
  spec: { type: "text", text: "t" },
  css: { ...DEFAULT_CSS, display: "inline", ...css },
  children: [],
  hugText: true,
});
const box = (x: number, y: number, w: number, h: number, css: Partial<Css> = {}): BoxNode => ({
  kind: "leaf",
  rect: { x, y, w, h },
  spec: { type: "rectangle" },
  css: { ...DEFAULT_CSS, ...css },
  children: [],
});
const frame = (x: number, y: number, w: number, h: number, css: Partial<Css>, children: BoxNode[]): BoxNode => ({
  kind: "frame",
  rect: { x, y, w, h },
  spec: { type: "frame" },
  css: { ...DEFAULT_CSS, ...css },
  children,
});

describe("simulate", () => {
  const layout = { direction: "horizontal" as const, gap: 10, counterGap: 0, padding: [0, 20, 0, 20] as [number, number, number, number], align: "start" as const, crossAlign: "start" as const, wrap: false };
  const item = (main: number, cross = 10) => ({ main, cross, fillMain: false, fillCross: false });

  it("distributes space-between without a gap", () => {
    const sim = simulate({ ...layout, align: "space-between" }, [item(50), item(50), item(50)], 400, 40, false, false);
    expect(sim.rects.map((r) => r.x)).toEqual([20, 175, 330]);
  });
  it("centres and end-aligns the main axis", () => {
    expect(simulate({ ...layout, align: "center" }, [item(100)], 300, 40, false, false).rects[0].x).toBe(100);
    expect(simulate({ ...layout, align: "end" }, [item(100)], 300, 40, false, false).rects[0].x).toBe(180);
  });
  it("splits leftover space between fill children", () => {
    const sim = simulate(layout, [item(50), { ...item(0), fillMain: true }, { ...item(0), fillMain: true }], 300, 40, false, false);
    expect(sim.rects.map((r) => r.w)).toEqual([50, 95, 95]);
  });
  it("hugs both axes", () => {
    const sim = simulate(layout, [item(50, 10), item(30, 24)], 0, 0, true, true);
    expect([sim.w, sim.h]).toEqual([50 + 30 + 10 + 40, 24]);
  });
  it("wraps rows with a separate row gap", () => {
    const l = { ...layout, padding: [0, 0, 0, 0] as [number, number, number, number], wrap: true, counterGap: 30 };
    const sim = simulate(l, [item(100, 50), item(100, 50), item(100, 50)], 250, 0, false, true);
    expect(sim.rects[2]).toMatchObject({ x: 0, y: 80 });
    expect(sim.h).toBe(130);
  });
});

describe("planContainer", () => {
  it("maps a flex row with space-between", () => {
    const nav = frame(0, 0, 1000, 60, { display: "flex", justifyContent: "space-between", alignItems: "center", inset: [10, 40, 10, 40] }, [
      text(40, 20, 60, 20),
      text(460, 20, 80, 20),
      text(900, 20, 60, 20),
    ]);
    const plan = planContainer(nav)!;
    expect(plan.layout).toMatchObject({ direction: "horizontal", align: "space-between", crossAlign: "center", gap: 0 });
    expect(plan.layout.padding[1]).toBe(40);
  });

  it("takes the gap from consistent margins in block flow", () => {
    const col = frame(0, 0, 400, 200, { inset: [10, 10, 10, 10] }, [box(10, 10, 380, 50), box(10, 74, 380, 50), box(10, 138, 380, 50)]);
    const plan = planContainer(col)!;
    expect(plan.layout).toMatchObject({ direction: "vertical", gap: 14 });
    expect([...plan.sizing.values()].every((s) => s.w === "fill")).toBe(true);
  });

  it("keeps absolute layout when gaps differ or boxes overlap", () => {
    const uneven = frame(0, 0, 400, 300, {}, [box(0, 0, 100, 50), box(0, 60, 100, 50), box(0, 130, 100, 50)]);
    expect(planContainer(uneven)).toBeNull();
    const overlap = frame(0, 0, 400, 300, {}, [box(0, 0, 100, 80), box(0, 40, 100, 80)]);
    expect(planContainer(overlap)).toBeNull();
    const ragged = frame(0, 0, 400, 300, {}, [box(0, 0, 100, 50), box(30, 60, 100, 50)]);
    expect(planContainer(ragged)).toBeNull();
  });

  it("turns flex-grow into fill and ignores out-of-flow children", () => {
    const row = frame(0, 0, 500, 40, { display: "flex", columnGap: 10 }, [
      box(0, 0, 100, 40),
      box(110, 0, 380, 40, { flexGrow: 1 }),
      box(400, 5, 30, 10, { position: "absolute" }),
    ]);
    const plan = planContainer(row)!;
    expect(plan.flow).toHaveLength(2);
    expect(plan.sizing.get(plan.flow[1])).toMatchObject({ w: "fill" });
    planTree(row);
    const spec = emitSpec(row, row.rect);
    expect(spec.children.map((c: any) => !!c.absolute)).toEqual([false, false, true]);
  });

  it("wraps a multi-row flex container", () => {
    const kids = [0, 1, 2, 3].map((i) => box((i % 2) * 120, Math.floor(i / 2) * 60, 100, 50));
    const wrap = frame(0, 0, 230, 110, { display: "flex", flexWrap: "wrap", columnGap: 20, rowGap: 10 }, kids);
    const plan = planContainer(wrap)!;
    expect(plan.layout).toMatchObject({ wrap: true, gap: 20, counterGap: 10 });
    expect(plan.canHug.w).toBe(false);
  });

  it("stacks a single-column grid vertically", () => {
    const grid = frame(0, 0, 300, 110, { display: "grid", rowGap: 10, gridColumns: 1 }, [box(0, 0, 300, 50), box(0, 60, 300, 50)]);
    expect(planContainer(grid)!.layout.direction).toBe("vertical");
  });
});

describe("emitSpec", () => {
  const tree = () => frame(0, 0, 400, 100, { display: "flex", columnGap: 8 }, [box(0, 0, 100, 100), box(108, 0, 100, 100)]);

  it("writes auto layout fields", () => {
    const root = tree();
    planTree(root);
    const spec = emitSpec(root, root.rect);
    expect(spec.layout).toMatchObject({ direction: "horizontal", gap: 8, align: "start" });
    expect(spec.children[1]).toMatchObject({ x: 108, width: 100 });
  });

  it("leaves children absolute when no plan was made", () => {
    const root = tree();
    const spec = emitSpec(root, root.rect);
    expect(spec.layout).toBeUndefined();
    expect(spec.children.map((c: any) => [c.x, c.y])).toEqual([[0, 0], [108, 0]]);
  });
});
