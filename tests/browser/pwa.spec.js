import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

const serviceWorkerTest = test.extend({ serviceWorkers: "allow" });
serviceWorkerTest(
  "public service worker caches only its allowlist and opens an anonymous offline screen",
  async ({ page, context, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "Playwright service-worker automation is Chromium-only",
    );
    await operationsFixture(page);
    await page.goto(baseURL + "/settings");
    await expect(
      page.getByRole("button", { name: "App & Benachrichtigungen", exact: true }),
    ).toBeVisible();
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      if (!registration.active)
        await new Promise((resolve) =>
          registration.installing.addEventListener("statechange", resolve),
        );
    });
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await page.evaluate(async () => {
      await fetch("/api/state");
      await fetch("/api/sessions/request-session/chat");
    });
    const keys = await page.evaluate(async () =>
      (await (await caches.open("agentpier-public-v1")).keys())
        .map((request) => new URL(request.url).pathname)
        .sort(),
    );
    expect(keys).toEqual(
      [
        "/apple-touch-icon.png",
        "/manifest.webmanifest",
        "/offline.html",
        "/pwa-icon-192.png",
        "/pwa-icon-512.png",
        "/pwa-maskable-512.png",
      ].sort(),
    );
    await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
    await context.setOffline(true);
    await page.goto(baseURL + "/sessions/private-id/chat");
    await expect(
      page.getByRole("heading", { name: "AgentPier ist offline", exact: true }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("private-id");
    expect(
      await page.evaluate(async () => {
        try {
          await fetch("/api/state");
          return "unexpected";
        } catch {
          return "offline";
        }
      }),
    ).toBe("offline");
  },
);
test("install prompt captured before visiting settings still requires an explicit click", async ({
  page,
}) => {
  await operationsFixture(page);
  await page.goto(baseURL + "/settings");
  await expect(
    page.getByRole("button", { name: "App & Benachrichtigungen", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__installCalls = 0;
    const event = new Event("beforeinstallprompt", { cancelable: true });
    event.prompt = async () => {
      window.__installCalls++;
    };
    window.dispatchEvent(event);
  });
  await page
    .getByRole("button", { name: "App & Benachrichtigungen", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "App installieren", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__installCalls)).toBe(0);
  await page.getByRole("button", { name: "App installieren", exact: true }).click();
  expect(await page.evaluate(() => window.__installCalls)).toBe(1);
});
serviceWorkerTest(
  "service worker notifications ignore supplied content and only open validated AgentPier routes",
  async ({ page, context, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "Playwright service-worker automation is Chromium-only",
    );
    await operationsFixture(page);
    await page.goto(baseURL + "/settings");
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    const worker = context.serviceWorkers().find((item) => item.url().endsWith("/sw.js"));
    const result = await worker.evaluate(async () => {
      let notification, opened;
      self.registration.showNotification = async (title, options) => {
        notification = { title, options };
      };
      self.clients.matchAll = async () => [];
      self.clients.openWindow = async (url) => {
        opened = url;
      };
      const dispatch = async (type, fields) => {
        let pending;
        const event = new Event(type);
        Object.assign(event, fields, {
          waitUntil: (promise) => {
            pending = promise;
          },
        });
        self.dispatchEvent(event);
        await pending;
      };
      await dispatch("push", {
        data: {
          json: () => ({
            kind: "permission",
            sessionId: "fixture-session",
            title: "PRIVATE COMMAND",
            body: "PRIVATE ANSWER",
            url: "https://untrusted.example/",
          }),
        },
      });
      await dispatch("notificationclick", {
        notification: { close() {}, data: notification.options.data },
      });
      const validTarget = opened;
      const permissionNotification = notification;
      await dispatch("push", {
        data: {
          json: () => ({
            kind: "session-completed",
            sessionId: "fixture-session",
            body: "PRIVATE ANSWER",
          }),
        },
      });
      const completionNotification = notification;
      await dispatch("notificationclick", {
        notification: {
          close() {},
          data: {
            sessionId: "../private",
            runId: "https://untrusted.example/",
            url: "https://untrusted.example/",
          },
        },
      });
      return {
        notification: permissionNotification,
        completionNotification,
        validTarget,
        rejectedTarget: opened,
      };
    });
    expect(result.completionNotification.title).toBe("AgentPier: Antwort bereit");
    expect(JSON.stringify(result.completionNotification)).not.toContain("PRIVATE");
    expect(result.notification.title).toBe("AgentPier: Freigabe erforderlich");
    expect(JSON.stringify(result.notification)).not.toMatch(/PRIVATE|untrusted/);
    expect(result.validTarget).toBe(
      new URL("/sessions/fixture-session/chat", baseURL).href,
    );
    expect(result.rejectedTarget).toBe(new URL("/settings/notifications", baseURL).href);
  },
);
