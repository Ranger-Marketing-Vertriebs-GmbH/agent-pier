import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const root = path.resolve(import.meta.dirname, "..", "..");

/**
 * Serves the shared settings components from source in an isolated page, so their
 * behaviour is tested before any product page renders them. No app server, no data.
 */
export async function startSettingsHarness() {
  const server = await createServer({
    configFile: false,
    root: path.join(root, "tests/browser/harness/settings-pattern"),
    cacheDir: path.join(root, ".cache/vite-settings-harness"),
    plugins: [react()],
    logLevel: "error",
    // Pre-bundling up front avoids a mid-test dependency reload.
    optimizeDeps: {
      include: ["react", "react-dom/client", "react/jsx-dev-runtime"],
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
  });
  await server.listen();
  return { url: server.resolvedUrls.local[0], close: () => server.close() };
}
