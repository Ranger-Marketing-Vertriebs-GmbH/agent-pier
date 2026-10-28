// Playwright's `test` for every browser spec (tests/unit/browser-spec-imports.test.js
// keeps it that way). Every page of the default context, the first one and every later
// one (context.newPage(), popups), gets the live socket stub of ./live-stub.js before
// the spec runs, so live topics answer from the spec's own REST mocks:
//   test.use({ live: "rest" })    default: topics follow the REST mocks
//   test.use({ live: "manual" })  topics send only what the test pushes (liveStub.push)
//   test.use({ live: "real" })    no stub: the page talks to the test server
// Contexts a spec makes with browser.newContext() take stubContext(context).
// See docs/testing.md#live-socket-stub.
import { test as base, expect } from "@playwright/test";
import { stubContext } from "./live-stub.js";

const stubbed = new WeakMap();

export const test = base.extend({
  live: ["rest", { option: true }],
  page: async ({ page, context, live }, use) => {
    if (live === "real") return use(page);
    const stubs = await stubContext(context, { mode: live });
    stubbed.set(page, stubs);
    try {
      await use(page);
    } finally {
      await stubs.dispose();
    }
  },
  liveStub: async ({ page }, use) => {
    await use((await stubbed.get(page)?.stubFor(page)) ?? null);
  },
});

export { expect };
