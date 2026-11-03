import { dispatch, getDoc, query } from "../store";
import type { DeviceFrame, Node } from "../types";
import { Section, Seg, SelectField } from "../ui/controls";
import * as A from "../actions";
import { InlineInput } from "./InlineInput";
import { devicePresets } from "./PresetPicker";
import { hasDeviceUi, type DevicePreset } from "./presetList";

/** Whether the Device section applies: one top-level frame or main component that is not itself system UI. */
export function isDeviceTarget(nodes: Node[]): boolean {
  const n = nodes[0];
  return nodes.length === 1 && ["frame", "component"].includes(n.type) && !n.parent && !n.devicePart;
}

/** The device of a screen frame: preset, light or dark, which bars show, and the safe area. */
export function DeviceSection({ node }: { node: Node }) {
  const device = node.device;
  const presets = devicePresets();
  const preset = presets.find((p) => p.id === device?.preset);
  const kind = preset?.kind ?? "none";
  const mobile = ["iosIsland", "iosNotch", "iosHome", "ipadHome", "android"].includes(kind);
  const set = (patch: Partial<DeviceFrame>) => device && A.setDevice(node.id, { ...device, ...patch }, false);
  const insets = device ? query<[number, number, number, number] | null>({ q: "deviceInsets", id: node.id }) : null;
  return (
    <Section title="Device">
      <div className="row">
        <SelectField
          ariaLabel="Device"
          value={device?.preset ?? ""}
          options={[{ value: "", label: "None" }, ...presets.filter(hasDeviceUi).map((p) => ({ value: p.id, label: `${p.label}  ${p.w}×${p.h}` }))]}
          onChange={(id) => (id ? A.setDevice(node.id, { ...(device ?? A.DEVICE_DEFAULTS), preset: id }, true) : A.setDevice(node.id, null, false))}
        />
      </div>
      {device && preset && (
        <>
          <div className="row">
            <Seg
              ariaLabel="Theme"
              value={device.theme}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              onChange={(theme) => set({ theme })}
            />
          </div>
          {mobile && (
            <label className="row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={device.statusBar} onChange={(e) => set({ statusBar: e.target.checked })} />
              Status bar
            </label>
          )}
          {["iosIsland", "iosNotch", "ipadHome", "android"].includes(kind) && (
            <label className="row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={device.homeIndicator} onChange={(e) => set({ homeIndicator: e.target.checked })} />
              {kind === "android" ? "Navigation bar" : "Home indicator"}
            </label>
          )}
          {kind === "android" && device.homeIndicator && (
            <div className="row">
              <Seg
                ariaLabel="Navigation"
                value={device.nav}
                options={[
                  { value: "gesture", label: "Gestures" },
                  { value: "buttons", label: "Buttons" },
                ]}
                onChange={(nav) => set({ nav })}
              />
            </div>
          )}
          {(kind === "macWindow" || kind === "browser") && (
            <label className="row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={device.chrome} onChange={(e) => set({ chrome: e.target.checked })} />
              Window chrome
            </label>
          )}
          {kind === "browser" && device.chrome && <InlineInput label="URL" title="Address" value={device.url} onCommit={(url) => set({ url: url.trim() })} />}
          {node.layout && preset.insets.some((v) => v > 0) && (
            <label className="row" style={{ cursor: "pointer" }} title="Adds the safe area to the auto layout padding, so content starts below the system UI">
              <input type="checkbox" checked={device.pad} onChange={(e) => set({ pad: e.target.checked })} />
              Pad content to safe area
            </label>
          )}
          {insets && <div className="muted small device-safe">{safeAreaLine(insets, kind)}</div>}
          {(kind === "macWindow" || kind === "browser") && (
            <div className="muted small device-safe">Code export leaves the window bar out; padding in code excludes it.</div>
          )}
        </>
      )}
    </Section>
  );
}

/** "Safe area 62 top · 34 bottom"; a window or browser frame has a bar, not a safe area. */
export function safeAreaLine(i: [number, number, number, number], kind = ""): string {
  const parts = (["top", "right", "bottom", "left"] as const).map((side, k) => (i[k] > 0 ? `${i[k]} ${side}` : "")).filter(Boolean);
  const label = kind === "macWindow" ? "Title bar" : kind === "browser" ? "Browser bar" : "Safe area";
  return parts.length ? `${label} ${parts.join(" · ")}` : kind === "macWindow" || kind === "browser" ? "No window bar" : "No safe area";
}

const up = (ids: string[], patch: Record<string, unknown>) => dispatch({ op: "update", ids, patch });

/** Resizes frames to a preset: a device frame keeps its theme and toggles and gets the new device's
 * system UI (none for a plain size); a plain frame only changes size. One undo step. */
export function resizeToPreset(nodes: Node[], p: DevicePreset) {
  const doc = getDoc();
  A.oneStep(() => {
    for (const n of nodes) {
      const cur = doc.nodes[n.id];
      if (cur?.device && !cur.parent) {
        if (hasDeviceUi(p)) A.setDevice(n.id, { ...cur.device, preset: p.id }, true);
        else {
          A.setDevice(n.id, null, false);
          up([n.id], { width: p.w, height: p.h, sizingH: "fixed", sizingV: "fixed" });
        }
      } else up([n.id], { width: p.w, height: p.h, sizingH: "fixed", sizingV: "fixed" });
    }
  });
}
