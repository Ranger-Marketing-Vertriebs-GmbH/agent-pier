import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../../server/app.js";

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
    await expect(page.getByRole("heading", { name: "Benutzer erstellen" })).toBeVisible();
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
    await page.getByRole("button", { name: "Benutzer erstellen", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Benutzer erstellen" })).toHaveCount(
      0,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(
      page.getByRole("button", { name: "Abmelden", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Abmelden", exact: true }),
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
    await page.getByRole("button", { name: "Abmelden", exact: true }).click();
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
    await expect(
      page.getByRole("button", { name: "Abmelden", exact: true }),
    ).toBeVisible();
  } finally {
    await application.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
