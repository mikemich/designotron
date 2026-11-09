import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const BRIDGE = `http://127.0.0.1:${process.env.DESIGNOTRON_PORT ?? 5174}`;
// `DT_SINGLE=1` builds one JS chunk with relative paths for the single-file preview.
/** The workspace version from the root Cargo.toml (the Docker web stage has no Cargo.toml: then npm's). */
export function appVersion(): string {
  try {
    const toml = readFileSync(new URL("../Cargo.toml", import.meta.url), "utf8");
    const section = toml.match(/\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
    const v = section.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
    if (v) return v;
  } catch {
    /* not in a checkout */
  }
  return process.env.npm_package_version ?? "dev";
}
const single = process.env.DT_SINGLE === "1";

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  // DT_BASE sets the public path for hosted builds (GitHub Pages serves /designotron/).
  base: single ? "./" : (process.env.DT_BASE ?? "/"),
  build: single ? { outDir: "dist-single", rollupOptions: { output: { inlineDynamicImports: true } } } : {},
  server: {
    port: 5173,
    proxy: {
      "/bridge": { target: BRIDGE, ws: true },
      "/collab": { target: BRIDGE, ws: true },
      "/mcp": BRIDGE,
    },
  },
});
