import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// Tapping an agent's push while AgentPier is open shows that agent's chat in the open
// window, through the app's own router (AGENTPIER-297): no reload, no second window.
const serviceWorkerTest = test.extend({ serviceWorkers: "allow" });

// Dispatches a notification tap in the real worker, against the real open window.
const tap = (worker, data) =>
  worker.evaluate(async (data) => {
    const opened = [];
    self.clients.openWindow = async (url) => {
      opened.push(url);
    };
    let pending;
    const event = new Event("notificationclick");
    Object.assign(event, {
      notification: { close() {}, data },
      waitUntil: (promise) => {
        pending = promise;
      },
    });
    self.dispatchEvent(event);
    await pending;
    return opened;
  }, data);

serviceWorkerTest(
  "an agent push opens the agent's chat in the open window",
  async ({ page, context, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "Playwright service-worker automation is Chromium-only",
    );
    await chatFixture(page);
    await page.goto(baseURL + "/inbox");
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    const worker = context.serviceWorkers().find((item) => item.url().endsWith("/sw.js"));
    // Survives only a navigation inside the page, never a reload.
    await page.evaluate(() => (window.__sameDocument = true));
    const opened = await tap(worker, { link: "/agents/home/chats/dinner" });
    expect(opened).toEqual([]);
    await expect(page).toHaveURL(baseURL + "/agents/home/chats/dinner");
    await expect(page.getByText("We can plan dinner together.")).toBeVisible();
    expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
    expect(context.pages()).toHaveLength(1);
  },
);
