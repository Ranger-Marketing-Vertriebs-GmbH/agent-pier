import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { startupPlugin } from "./scripts/startup-plugin.mjs";
import { devPorts } from "./server/lib/dev-ports.js";

// Only the dev server reads the ports: a build or preview in a stage with a one-port
// block must not fail over a server it never starts.
export function devServer(env = process.env) {
  const { backend, vite } = devPorts(env);
  const target = `http://127.0.0.1:${backend}`;
  return {
    port: vite,
    // The backend admits exactly this port, so a busy port fails instead of moving on.
    strictPort: true,
    proxy: {
      "/api": { target, ws: true },
      "/auth": { target },
    },
  };
}

export default defineConfig(({ command, isPreview }) => ({
  plugins: [react(), startupPlugin()],
  server: {
    host: "127.0.0.1",
    ...(command === "serve" && !isPreview ? devServer() : {}),
  },
  build: {
    outDir: "dist",
    license: { fileName: "third-party-licenses.txt" },
    rolldownOptions: {
      output: {
        postBanner: "/*! Bundled dependency licenses: /third-party-licenses.txt */",
      },
    },
  },
}));
