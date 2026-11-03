// Pure helpers for the device preset picker: grouping, filtering and keyboard movement.

/** A row of the engine's preset table (`devicePresets` query). */
export interface DevicePreset {
  id: string;
  group: string;
  label: string;
  w: number;
  h: number;
  /** Which system UI the preset gets: iosIsland, iosNotch, iosHome, ipadHome, android, macWindow, browser or none. */
  kind: string;
  /** Safe area: top, right, bottom, left. */
  insets: [number, number, number, number];
}

export interface PresetGroup {
  group: string;
  items: DevicePreset[];
}

/** Presets that have system UI to build. */
export const hasDeviceUi = (p: DevicePreset) => p.kind !== "none";

/** Groups in the order they first appear. */
export function groupPresets(list: DevicePreset[]): PresetGroup[] {
  const out: PresetGroup[] = [];
  for (const p of list) {
    const g = out.find((x) => x.group === p.group);
    if (g) g.items.push(p);
    else out.push({ group: p.group, items: [p] });
  }
  return out;
}

/** Presets whose label, group, id or size match every word of `query` ("pro", "390", "1440x900"). */
export function filterPresets(list: DevicePreset[], query: string): DevicePreset[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((p) => {
    const hay = [p.label, p.group, p.id, String(p.w), String(p.h), `${p.w}x${p.h}`].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w.replace("×", "x")));
  });
}

/** The highlighted row after a key: -1 means none yet; Up and Down wrap around. */
export function nextIndex(current: number, count: number, key: string): number {
  if (count <= 0) return -1;
  switch (key) {
    case "ArrowDown":
      return current < 0 || current >= count - 1 ? 0 : current + 1;
    case "ArrowUp":
      return current <= 0 ? count - 1 : current - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return current;
  }
}
