import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../../server/app.js";

const owner = { username: "owner", password: "disposable-owner-password" };
const anna = {
  username: "Anna",
  displayName: "Anna K",
  password: "disposable-user-pass",
};

// The spec's own server: the owner signs up, then creates a user through the owner API.
async function server() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-user-browser-"));
  const application = await createApplication({ dataDir: root, home: root, port: 0 });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${application.server.address().port}`;
  const post = (endpoint, body, cookie = "") =>
    fetch(url + endpoint, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
  const setup = await post("/auth/setup", owner);
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const created = await post("/api/users", anna, cookie);
  if (created.status !== 201) throw new Error(`User not created: ${created.status}`);
  return {
    url,
    close: async () => {
      await application.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

for (const [language, copy] of [
  [
    "de",
    {
      title: "Anmelden",
      username: "Benutzername",
      password: "Passwort",
      empty: "Deine Agenten erscheinen hier.",
      logout: "Abmelden",
      forbidden: ["Sessions", "Einstellungen", "Projekte"],
    },
  ],
  [
    "en",
    {
      title: "Sign in",
      username: "Username",
      password: "Password",
      empty: "Your agents will appear here.",
      logout: "Sign out",
      forbidden: ["Sessions", "Settings", "Projects"],
    },
  ],
])
  test(`a user signs in and sees only her shell (${language})`, async ({
    page,
    context,
  }) => {
    const app = await server();
    try {
      await context.clearCookies();
      await page.addInitScript(
        (value) => localStorage.setItem("agentpier-language", value),
        language,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(app.url);
      await expect(
        page.getByRole("heading", { name: copy.title, exact: true }),
      ).toBeVisible();
      await page.getByLabel(copy.username, { exact: true }).fill(anna.username);
      await page.getByLabel(copy.password, { exact: true }).fill(anna.password);
      await page.getByRole("button", { name: copy.title, exact: true }).click();
      await expect(page.getByRole("heading", { name: "Anna K" })).toBeVisible();
      await expect(page.getByText(copy.empty)).toBeVisible();
      for (const text of copy.forbidden)
        await expect(page.getByText(text, { exact: true })).toHaveCount(0);
      await expect(
        page.getByRole("navigation", { name: /Hauptnavigation|Main navigation/ }),
      ).toHaveCount(0);
      expect((await page.request.get(app.url + "/api/state")).status()).toBe(404);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      await page.getByRole("button", { name: copy.logout, exact: true }).click();
      await expect(
        page.getByRole("heading", { name: copy.title, exact: true }),
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });
