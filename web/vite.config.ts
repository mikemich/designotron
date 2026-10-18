import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BRIDGE = `http://127.0.0.1:${process.env.DESIGNOTRON_PORT ?? 5174}`;
// `DT_SINGLE=1` builds one JS chunk with relative paths for the single-file preview.
const single = process.env.DT_SINGLE === "1";

export default defineConfig({
  plugins: [react()],
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
