import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BRIDGE = `http://127.0.0.1:${process.env.DESIGNOTRON_PORT ?? 5174}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/bridge": { target: BRIDGE, ws: true },
      "/mcp": BRIDGE,
    },
  },
});
