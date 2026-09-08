import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target: "http://127.0.0.1:4380", ws: true },
      "/auth": { target: "http://127.0.0.1:4380" },
    },
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
});
