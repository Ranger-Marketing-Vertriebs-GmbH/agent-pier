// Playwright's `test` for every browser spec (tests/unit/browser-spec-imports.test.js
// keeps it that way). Each `page` gets the live socket stub of ./live-stub.js before
// the spec runs, so live topics answer from the spec's own REST mocks:
//   test.use({ live: "rest" })    default: topics follow the REST mocks
//   test.use({ live: "manual" })  topics send only what the test pushes (liveStub.push)
//   test.use({ live: "real" })    no stub: the page talks to the test server
// See docs/testing.md#live-socket-stub.
import { test as base, expect } from "@playwright/test";
import { stubLive } from "./live-stub.js";

const stubs = new WeakMap();

export const test = base.extend({
  live: ["rest", { option: true }],
  page: async ({ page, live }, use) => {
    if (live === "real") return use(page);
    const stub = await stubLive(page, { mode: live });
    stubs.set(page, stub);
    try {
      await use(page);
    } finally {
      stub.dispose();
    }
  },
  liveStub: async ({ page }, use) => {
    await use(stubs.get(page) ?? null);
  },
});

export { expect };
