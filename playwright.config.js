import { defineConfig } from "@playwright/test";

// The former TUIUI_* names stay accepted for existing local setups.
const externalUrl = process.env.AGENTPIER_TEST_URL || process.env.TUIUI_TEST_URL;
const storageState =
  process.env.AGENTPIER_TEST_STORAGE_STATE || process.env.TUIUI_TEST_STORAGE_STATE;
const browserChannel =
  process.env.AGENTPIER_BROWSER_CHANNEL || process.env.TUIUI_BROWSER_CHANNEL;
const baseURL =
  externalUrl || `http://127.0.0.1:${process.env.AGENTPIER_TEST_PORT || 4389}`;
const browserName = process.env.AGENTPIER_TEST_BROWSER || "chromium";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  // One visible retry in CI: scripts/playwright-flaky-reporter.mjs lists every
  // test that passed only on its retry in the job summary.
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    locale: "de-DE",
    ...(!externalUrl
      ? { storageState: `.cache/browser-auth-${new URL(baseURL).port}.json` }
      : storageState
        ? { storageState }
        : {}),
    browserName,
    channel:
      browserName === "chromium"
        ? browserChannel ||
          (!process.env.CI && process.platform === "darwin" ? "chrome" : undefined)
        : undefined,
    // API-fixture routing must not be bypassed by a controlling service worker.
    // The dedicated PWA suite explicitly enables real workers.
    serviceWorkers: "block",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
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
          // The default SIGKILL would skip the cleanup of the server's temp folder.
          gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
        },
      }),
  // The browser comes from AGENTPIER_TEST_BROWSER (CI runs Chromium and WebKit).
  // Agent pages are also used on iPads, so their specs repeat at tablet size, once,
  // in WebKit: the engine every iPad browser uses.
  projects: [
    { name: "desktop" },
    ...(browserName === "webkit"
      ? [
          {
            name: "tablet",
            testMatch: "**/assistant*.spec.js",
            use: {
              viewport: { width: 820, height: 1180 },
              hasTouch: true,
              isMobile: true,
            },
          },
        ]
      : []),
  ],
  reporter: process.env.CI
    ? [["list"], ["./scripts/playwright-flaky-reporter.mjs"]]
    : "list",
});
