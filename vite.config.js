import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
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

// pdf.js reads these at run time, so they are copied as they are to
// /assets/pdfjs/ (web/features/assistants/pdf-document.js): the stand-in fonts for
// PDFs that do not embed theirs, and the JavaScript image decoders that replace the
// WebAssembly ones the app CSP does not allow. Their licenses travel with them.
const pdfjsRoot = path.dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist-browser/package.json"),
);
const pdfjsFiles = {
  standard_fonts: () => true,
  // Only the openjpeg and jbig2 decoders ship, with their licenses.
  wasm: (name) =>
    /^(?:(?:openjpeg|jbig2)_nowasm_fallback\.js|LICENSE_(?:PDFJS_)?(?:OPENJPEG|JBIG2))$/.test(
      name,
    ),
};
export function pdfjsAssets() {
  const files = Object.entries(pdfjsFiles).flatMap(([folder, wanted]) =>
    readdirSync(path.join(pdfjsRoot, folder))
      .filter(wanted)
      .map((name) => `${folder}/${name}`),
  );
  return {
    name: "agentpier-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/assets/pdfjs/", (req, res, next) => {
        const name = decodeURIComponent(new URL(req.url, "http://dev").pathname.slice(1));
        if (!files.includes(name)) return next();
        res.setHeader(
          "Content-Type",
          name.endsWith(".js") ? "text/javascript" : "application/octet-stream",
        );
        res.end(readFileSync(path.join(pdfjsRoot, name)));
      });
    },
    generateBundle() {
      for (const name of files)
        this.emitFile({
          type: "asset",
          fileName: `assets/pdfjs/${name}`,
          source: readFileSync(path.join(pdfjsRoot, name)),
        });
    },
  };
}

export default defineConfig(({ command, isPreview }) => ({
  plugins: [react(), startupPlugin(), pdfjsAssets()],
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
