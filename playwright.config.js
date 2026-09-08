import { defineConfig } from "@playwright/test";

const externalUrl = process.env.TUIUI_TEST_URL;
const baseURL =
  externalUrl || `http://127.0.0.1:${process.env.AGENTPIER_TEST_PORT || 4389}`;
const browserName = process.env.AGENTPIER_TEST_BROWSER || "chromium";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL,
    locale: "de-DE",
    ...(!externalUrl
      ? { storageState: `.cache/browser-auth-${new URL(baseURL).port}.json` }
      : process.env.TUIUI_TEST_STORAGE_STATE
        ? { storageState: process.env.TUIUI_TEST_STORAGE_STATE }
        : {}),
    browserName,
    channel:
      browserName === "chromium"
        ? process.env.TUIUI_BROWSER_CHANNEL ||
          (!process.env.CI && process.platform === "darwin" ? "chrome" : undefined)
        : undefined,
    // API-fixture routing must not be bypassed by a controlling service worker.
    // The dedicated PWA suite explicitly enables real workers.
    serviceWorkers: "block",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  ...(externalUrl
    ? {}
    : {
        globalSetup: "./tests/helpers/browser-login-setup.js",
        webServer: {
          command: "node scripts/test-server.mjs",
          url: baseURL,
          reuseExistingServer: false,
          timeout: 20000,
        },
      }),
  reporter: "list",
});
