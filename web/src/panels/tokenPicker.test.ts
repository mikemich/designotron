import { describe, expect, it } from "vitest";
import { firstItem, matchesQuery, moveActive, pickerRows, ROW_CAP, type PickerItem, type PickerRow } from "./tokenPicker";

const item = (name: string, extra: Partial<PickerItem> = {}): PickerItem => ({ id: name, name, ...extra });
const allOpen = () => true;
const allShut = () => false;
const kinds = (rows: PickerRow[]) => rows.map((r) => r.type);
const labels = (rows: PickerRow[]) => rows.map((r) => (r.type === "item" || r.type === "folder" || r.type === "group" ? r.label : r.type));

describe("pickerRows", () => {
  const styles = [item("Brand/Primary/500"), item("Brand/Primary/600"), item("Brand/Danger"), item("Neutral/Ink"), item("Plain")];

  it("groups by slash folders in first-seen order", () => {
    const { rows, matched, drawn } = pickerRows(styles, "", allOpen);
    expect(labels(rows)).toEqual(["Brand", "Primary", "500", "600", "Danger", "Neutral", "Ink", "Plain"]);
    expect([matched, drawn]).toEqual([5, 5]);
    expect(rows.filter((r) => r.type === "folder").map((r) => (r as { depth: number }).depth)).toEqual([0, 1, 0]);
  });

  it("leaves a folded folder's items out and reports its size", () => {
    const { rows } = pickerRows(styles, "", (k) => k === "f::Brand");
    expect(labels(rows)).toEqual(["Brand", "Primary", "Danger", "Neutral", "Plain"]);
    const brand = rows[0] as { count: number; open: boolean };
    expect([brand.open, brand.count]).toEqual([true, 3]);
    const folded = pickerRows(styles, "", allShut).rows;
    expect(labels(folded)).toEqual(["Brand", "Neutral", "Plain"]);
    expect((folded[0] as { open: boolean; count: number }).count).toBe(3);
  });

  it("searches case and accent insensitively, opening every folder", () => {
    const rows = pickerRows([item("Écran/Fond"), item("Brand/DANGER"), item("Brand/Primary")], "danger", allShut).rows;
    expect(labels(rows)).toEqual(["Brand", "DANGER"]);
    expect((rows[1] as { hint: string }).hint).toBe("Brand");
    expect(labels(pickerRows([item("Écran/Fond"), item("Other")], "ECRAN", allShut).rows)).toEqual(["Écran", "Fond"]);
    expect(pickerRows(styles, "zzz", allOpen)).toEqual({ rows: [], matched: 0, drawn: 0 });
  });

  it("matches every word, in the name, the collection or the description", () => {
    const v = item("Surface/Card", { group: "Theme", description: "Cards and sheets" });
    expect(matchesQuery(v, "theme card")).toBe(true);
    expect(matchesQuery(v, "sheets surface")).toBe(true);
    expect(matchesQuery(v, "card nope")).toBe(false);
    expect(matchesQuery(v, "   ")).toBe(true);
  });

  it("lists one heading per collection, folded or searched", () => {
    const vars = [item("Brand", { group: "Primitives" }), item("Space/2", { group: "Primitives" }), item("Surface", { group: "Theme" })];
    expect(labels(pickerRows(vars, "", allOpen).rows)).toEqual(["Primitives", "Space", "2", "Brand", "Theme", "Surface"]);
    expect(labels(pickerRows(vars, "", allShut).rows)).toEqual(["Primitives", "Theme"]);
    expect(labels(pickerRows(vars, "surf", allShut).rows)).toEqual(["Theme", "Surface"]);
    // Items drawn under a heading are one level in.
    const rows = pickerRows(vars, "", allOpen).rows;
    expect((rows[1] as { depth: number }).depth).toBe(1);
  });

  it("names an item with an empty name", () => {
    const rows = pickerRows([item("", { id: "e" })], "", allOpen).rows;
    expect(labels(rows)).toEqual(["Untitled"]);
  });

  it("draws at most 200 rows and counts the rest", () => {
    const many = Array.from({ length: 2000 }, (_, i) => item(`S${i}`));
    const { rows, matched, drawn } = pickerRows(many, "", allOpen);
    expect(rows).toHaveLength(ROW_CAP + 1);
    expect(rows[ROW_CAP]).toEqual({ type: "more", key: "more", hidden: 1800 });
    expect([matched, drawn]).toEqual([2000, 200]);
    // A search narrows below the cap.
    const found = pickerRows(many, "S19", allOpen);
    expect(found.matched).toBe(111);
    expect(kinds(found.rows)).not.toContain("more");
    // Folded folders of a long list are a handful of rows.
    const folders = Array.from({ length: 2000 }, (_, i) => item(`F${i % 20}/S${i}`));
    expect(pickerRows(folders, "", allShut).rows).toHaveLength(20);
  });

  it("builds 2,000 rows quickly", () => {
    const many = Array.from({ length: 2000 }, (_, i) => item(`Group ${i % 40}/Sub ${i % 7}/Style ${i}`, { description: "d" }));
    const t = performance.now();
    for (let i = 0; i < 20; i++) pickerRows(many, "style 19", allOpen);
    expect((performance.now() - t) / 20).toBeLessThan(50);
  });
});

describe("keys", () => {
  const rows = pickerRows([item("A/x"), item("A/y"), item("b")], "", allOpen).rows; // folder A, x, y, b
  const withMore: PickerRow[] = [...rows, { type: "more", key: "more", hidden: 3 }];

  it("moves between rows and stops at the ends", () => {
    expect(moveActive(rows, -1, "ArrowDown")).toBe(0);
    expect(moveActive(rows, 0, "ArrowDown")).toBe(1);
    expect(moveActive(rows, 3, "ArrowDown")).toBe(3);
    expect(moveActive(rows, 1, "ArrowUp")).toBe(0);
    expect(moveActive(rows, 0, "ArrowUp")).toBe(0);
    expect(moveActive(rows, -1, "ArrowUp")).toBe(3);
    expect(moveActive(rows, 2, "Home")).toBe(0);
    expect(moveActive(rows, 0, "End")).toBe(3);
  });

  it("never lands on the 'more' row", () => {
    expect(moveActive(withMore, 3, "ArrowDown")).toBe(3);
    expect(moveActive(withMore, 0, "End")).toBe(3);
    expect(moveActive([], -1, "ArrowDown")).toBe(-1);
  });

  it("skips the folders a search holds open: Down lands on the first match", () => {
    const found = pickerRows([item("Brand/Danger/1"), item("Brand/Danger/2"), item("Other")], "danger", allShut).rows; // Brand, Danger, 1, 2
    expect(labels(found)).toEqual(["Brand", "Danger", "1", "2"]);
    expect(moveActive(found, -1, "ArrowDown")).toBe(2);
    expect(moveActive(found, 2, "ArrowDown")).toBe(3);
    expect(moveActive(found, 3, "ArrowUp")).toBe(2);
    expect(moveActive(found, 2, "ArrowUp")).toBe(2);
    expect(moveActive(found, -1, "End")).toBe(3);
  });

  it("finds the first item for Enter after typing", () => {
    expect(firstItem(rows)).toBe(1);
    expect(firstItem([])).toBe(-1);
  });
});
