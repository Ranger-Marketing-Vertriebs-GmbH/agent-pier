import { test, expect } from "../helpers/browser-test.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../../server/app.js";
import { openMenu } from "../helpers/navigation.js";
import { baseURL } from "../helpers/browser.js";
import { setTabHidden } from "../helpers/visibility.js";

test("first user setup, reload, logout and login protect the complete workspace", async ({
  page,
  context,
  browserName,
}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-login-browser-"));
  const application = await createApplication({ dataDir: root, home: root, port: 0 });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${application.server.address().port}`;
  try {
    await context.clearCookies();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url + "/settings");
    await expect(
      page.getByRole("heading", { name: "Besitzerkonto anlegen" }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toHaveCount(
      0,
    );
    await page.screenshot({
      path: `/tmp/agentpier-login-setup-${browserName}.png`,
      fullPage: true,
    });
    await page.getByLabel("Benutzername", { exact: true }).fill("owner");
    await page
      .getByLabel("Passwort", { exact: true })
      .fill("disposable-browser-password");
    await page.getByLabel("Passwort wiederholen").fill("disposable-browser-password");
    await page
      .getByRole("button", { name: "Besitzerkonto anlegen", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Besitzerkonto anlegen" }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openMenu(page);
    await expect(
      page
        .locator("#sidebar-menu")
        .getByRole("button", { name: "Abmelden", exact: true }),
    ).toBeVisible();
    await page.reload();
    await openMenu(page);
    await expect(
      page
        .locator("#sidebar-menu")
        .getByRole("button", { name: "Abmelden", exact: true }),
    ).toBeVisible();
    let releaseStatus;
    let statusRequested;
    const delayedStatus = new Promise((resolve) => {
      releaseStatus = resolve;
    });
    const requested = new Promise((resolve) => {
      statusRequested = resolve;
    });
    await page.route("**/auth/status", async (route) => {
      statusRequested();
      await delayedStatus;
      await route.fulfill({
        json: { configured: true, authenticated: true, canSetup: false },
      });
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await requested;
    await openMenu(page);
    await page
      .locator("#sidebar-menu")
      .getByRole("button", { name: "Abmelden", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Anmelden", exact: true }),
    ).toBeVisible();
    const bounds = await page.locator(".login-page").boundingBox();
    expect(bounds.x).toBe(0);
    expect(bounds.width).toBe(1440);
    const leakedRequests = [];
    const observe = (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        leakedRequests.push(request.url());
    };
    page.on("request", observe);
    const finished = page.waitForResponse("**/auth/status");
    releaseStatus();
    await (await finished).finished();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    page.off("request", observe);
    expect(leakedRequests).toEqual([]);
    await page.unroute("**/auth/status");
    await expect(
      page.getByRole("heading", { name: "Anmelden", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(async () => (await fetch("/api/state")).status)).toBe(401);
    await page.getByLabel("Benutzername", { exact: true }).fill("owner");
    await page.getByLabel("Passwort", { exact: true }).fill("incorrect-password");
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Benutzername oder Passwort ist falsch",
    );
    await page
      .getByLabel("Passwort", { exact: true })
      .fill("disposable-browser-password");
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await openMenu(page);
    await expect(
      page
        .locator("#sidebar-menu")
        .getByRole("button", { name: "Abmelden", exact: true }),
    ).toBeVisible();
  } finally {
    await application.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test.describe("English login failures", () => {
  test.use({ locale: "en-GB" });
  test("real backend errors are translated for wrong credentials and throttling", async ({
    page,
    context,
    browserName,
  }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-login-errors-"));
    const application = await createApplication({ dataDir: root, home: root, port: 0 });
    await application.login.setup({ username: "owner", password: "disposable-password" });
    await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${application.server.address().port}`;
    try {
      await context.clearCookies();
      await page.goto(url);
      await expect(
        page.getByRole("heading", { name: "Sign in", exact: true }),
      ).toBeVisible();
      await page.getByLabel("Username", { exact: true }).fill("owner");
      await page.getByLabel("Password", { exact: true }).fill("incorrect-password");
      const invalid = page.waitForResponse("**/auth/login");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      expect((await (await invalid).json()).code).toBe("LOGIN_CREDENTIALS_INVALID");
      await expect(page.getByRole("alert")).toHaveText(
        "Username or password is incorrect.",
      );
      await page.screenshot({
        path: `.cache/feature-review-fixes/login-english-${browserName}.png`,
        fullPage: true,
      });
      for (let attempt = 0; attempt < 9; attempt++) {
        await page.request.post(url + "/auth/login", {
          headers: { origin: url },
          data: { username: "owner", password: "incorrect-password" },
        });
      }
      const throttled = page.waitForResponse("**/auth/login");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const response = await throttled;
      expect(response.status()).toBe(429);
      expect(response.headers()["retry-after"]).toBe("60");
      await expect(page.getByRole("alert")).toHaveText(
        "Too many sign-in attempts. Please wait a minute.",
      );
    } finally {
      await application.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// The live channel closes a socket whose login ended with 1008; the login gate then
// reads /auth/status once instead of waiting for its 5-minute poll.
async function refusedLiveFixture(page) {
  const login = { authenticated: true, reads: 0, hold: null };
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route("**/auth/status", async (route) => {
    login.reads += 1;
    await login.hold;
    await route.fulfill({
      json: { configured: true, authenticated: login.authenticated, canSetup: false },
    });
  });
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  return login;
}

test("a live socket refused with 1008 reads the login and shows it when logged out", async ({
  page,
  liveStub,
}) => {
  const login = await refusedLiveFixture(page);
  await page.goto(baseURL + "/settings");
  await liveStub.waitForSubscribe("state");
  await expect.poll(() => login.reads).toBe(1);
  login.authenticated = false;
  liveStub.close(1008);
  await expect.poll(() => login.reads, { timeout: 1000 }).toBe(2);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});

test("repeated 1008 closes while logged in cause no burst of login reads", async ({
  page,
  liveStub,
}) => {
  const login = await refusedLiveFixture(page);
  await page.goto(baseURL + "/settings");
  await liveStub.waitForSubscribe("state");
  await expect.poll(() => login.reads).toBe(1);
  let release;
  login.hold = new Promise((resolve) => (release = resolve));
  // Each close reaches a reconnected socket; the first read is still running.
  for (let close = 0; close < 3; close++) {
    liveStub.close(1008);
    await liveStub.waitForSubscribe("state");
  }
  expect(login.reads).toBe(2);
  release();
  await page.waitForTimeout(1000);
  expect(login.reads).toBe(2);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toHaveCount(
    0,
  );
});

test("a 1008 close in a hidden tab reads the login only once it is shown", async ({
  page,
  liveStub,
}) => {
  const login = await refusedLiveFixture(page);
  await page.goto(baseURL + "/settings");
  await liveStub.waitForSubscribe("state");
  await expect.poll(() => login.reads).toBe(1);
  await setTabHidden(page, true);
  liveStub.close(1008);
  await page.waitForTimeout(1000);
  expect(login.reads).toBe(1);
  // The visible-only poll reads at once when the tab is shown again.
  await setTabHidden(page, false);
  await expect.poll(() => login.reads, { timeout: 1000 }).toBe(2);
});
