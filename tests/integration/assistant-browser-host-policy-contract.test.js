import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { importOpenClawExports } from "../helpers/openclaw-dist-exports.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { detectBrowser } from "../../server/features/assistants/browser-detection.js";

const installed = process.env.AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME;
const options = { skip: !installed, timeout: 60000 };
const allowedHost = "qa.example.test";

// Execute the pinned distribution, not a copy of its policy implementation.
async function runtime() {
  const root = path.join(installed, "app/node_modules/openclaw");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version,
    runtimeManifest.version,
  );
  const config = await import(
    pathToFileURL(path.join(root, "dist/extensions/browser/browser-config.js"))
  );
  return {
    ...config,
    ...(await importOpenClawExports(root, [
      "OpenClawSchema",
      "assertBrowserNavigationAllowed",
      "requiresInspectableBrowserNavigationRedirectsForUrl",
      "gotoPageWithNavigationGuard",
      "assertPageNavigationCompletedSafely",
    ])),
  };
}

test(
  "native browser host exceptions are global, not profile scoped",
  options,
  async () => {
    const { OpenClawSchema, resolveBrowserConfig, resolveProfile } = await runtime();
    const browser = {
      ssrfPolicy: { allowedHostnames: [allowedHost] },
      profiles: {
        mira: { driver: "openclaw", cdpPort: 20020 },
        other: { driver: "openclaw", cdpPort: 20021 },
      },
    };
    assert.equal(OpenClawSchema.safeParse({ browser }).success, true);
    const resolved = resolveBrowserConfig(browser);
    assert.deepEqual(resolved.ssrfPolicy.allowedHostnames, [allowedHost]);
    for (const name of ["mira", "other"]) {
      assert.equal(Object.hasOwn(resolveProfile(resolved, name), "ssrfPolicy"), false);
      const result = OpenClawSchema.safeParse({
        browser: {
          ...browser,
          profiles: {
            [name]: { ...browser.profiles[name], ssrfPolicy: browser.ssrfPolicy },
          },
        },
      });
      assert.equal(result.success, false);
      assert.ok(result.error.issues.some((issue) => issue.code === "unrecognized_keys"));
    }
  },
);

test(
  "native exact-host DNS exceptions and strict-mode limitations",
  options,
  async () => {
    const {
      assertBrowserNavigationAllowed: check,
      requiresInspectableBrowserNavigationRedirectsForUrl: needsInspection,
    } = await runtime();
    const lookupFn = async () => [{ address: "10.20.30.40", family: 4 }];
    const ssrfPolicy = { allowedHostnames: [allowedHost] };
    const url = `https://${allowedHost}/`;
    await assert.rejects(check({ url, lookupFn }), /private|internal/i);
    await check({ url, lookupFn, ssrfPolicy });
    for (const host of ["other.example.test", `child.${allowedHost}`])
      await assert.rejects(
        check({ url: `https://${host}/`, lookupFn, ssrfPolicy }),
        /private|internal/i,
      );
    for (const address of [
      "127.0.0.1",
      "169.254.1.1",
      "169.254.169.254",
      "::1",
      "fe80::1",
    ])
      await assert.rejects(
        check({
          url,
          ssrfPolicy,
          lookupFn: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        }),
        /private|internal/i,
      );
    const publicUrl = "https://public.example.test/";
    const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
    await check({ url: publicUrl, lookupFn: publicLookup });
    await assert.rejects(
      check({
        url: publicUrl,
        lookupFn: publicLookup,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
      /IP-literal URL/,
    );
    assert.equal(needsInspection(url, ssrfPolicy), false);
    assert.equal(needsInspection(url, { dangerouslyAllowPrivateNetwork: false }), true);
  },
);

async function listen(t, host, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://${host}:${server.address().port}`;
}

test(
  "native browser redirect rejection is not a pre-request network boundary",
  options,
  async (t) => {
    const native = await runtime();
    const executablePath =
      process.env.AGENTPIER_TEST_BROWSER_PATH || detectBrowser().executablePath;
    if (!executablePath) {
      assert.ok(!process.env.CI, "CI requires a Chromium browser");
      return t.skip("no Chromium browser");
    }
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      chromiumSandbox: true,
    });
    t.after(() => browser.close());
    let blockedRequests = 0;
    const source = await listen(t, "127.0.0.1", (req, res) => {
      if (req.url === "/destination") {
        blockedRequests++;
        res.end("blocked target fixture");
      } else {
        res.writeHead(302, { location: `${blocked}/destination` });
        res.end();
      }
    });
    // localhost and the literal reach the same disposable listener. Using two
    // hostnames avoids requiring a second loopback alias on macOS.
    const blocked = source.replace("127.0.0.1", "localhost");
    const deniedPage = await browser.newPage();
    await assert.rejects(
      native.gotoPageWithNavigationGuard({
        page: deniedPage,
        cdpUrl: "http://127.0.0.1:1",
        ssrfPolicy: {},
        url: `${blocked}/destination`,
        timeoutMs: 10000,
      }),
      /private|internal/i,
    );
    assert.equal(blockedRequests, 0, "default policy blocks a direct private navigation");
    // Only this disposable fixture explicitly trusts a loopback literal. No product
    // configuration is written. The localhost hostname is never allowed.
    const ssrfPolicy = { allowedHostnames: ["127.0.0.1"] };
    const page = await browser.newPage();
    const opts = { page, cdpUrl: "http://127.0.0.1:1", ssrfPolicy, timeoutMs: 10000 };
    await assert.rejects(
      native.assertBrowserNavigationAllowed({
        url: `${blocked}/destination`,
        ssrfPolicy,
      }),
      /private|internal/i,
    );
    assert.equal(blockedRequests, 0);
    const response = await native.gotoPageWithNavigationGuard({
      ...opts,
      url: `${source}/`,
    });
    await assert.rejects(
      native.assertPageNavigationCompletedSafely({ ...opts, response }),
      /private|internal/i,
    );
    assert.ok(
      blockedRequests > 0,
      "the redirect target was reached before the result was denied",
    );
  },
);
