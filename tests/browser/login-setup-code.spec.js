import { test, expect } from "../helpers/browser-test.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../../server/app.js";

// The form as a device on the plain network sees it: the status asks for the setup code.
// The spec's own server is reached on loopback, where the code itself is not checked;
// the server side is covered by tests/blackbox/login-setup-code.test.js.
for (const [language, copy] of [
  [
    "de",
    {
      title: "Besitzerkonto anlegen",
      username: "Benutzername",
      password: "Passwort",
      repeat: "Passwort wiederholen",
      code: "Einrichtungscode",
      hint: /npm run setup-code/,
      wrong: /Der Einrichtungscode stimmt nicht/,
    },
  ],
  [
    "en",
    {
      title: "Create owner account",
      username: "Username",
      password: "Password",
      repeat: "Repeat password",
      code: "Setup code",
      hint: /npm run setup-code/,
      wrong: /The setup code is not correct/,
    },
  ],
])
  test(`network setup asks for the setup code and sends it (${language})`, async ({
    page,
    context,
  }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-setup-code-"));
    const application = await createApplication({ dataDir: root, home: root, port: 0 });
    await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${application.server.address().port}`;
    try {
      await context.clearCookies();
      await page.addInitScript(
        (value) => localStorage.setItem("agentpier-language", value),
        language,
      );
      await page.route("**/auth/status", async (route) => {
        const response = await route.fetch();
        const status = await response.json();
        await route.fulfill({
          response,
          json: status.configured ? status : { ...status, needsSetupCode: true },
        });
      });
      const sent = [];
      await page.route("**/auth/setup", async (route) => {
        const body = route.request().postDataJSON();
        sent.push(body);
        if (body.setupCode !== "abcd-efgh-jklm")
          return route.fulfill({
            status: 403,
            json: { code: "LOGIN_SETUP_CODE_INVALID", error: "" },
          });
        await route.continue();
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(url);
      await expect(page.getByRole("heading", { name: copy.title })).toBeVisible();
      await expect(page.getByText(copy.hint)).toBeVisible();
      await page.getByLabel(copy.username, { exact: true }).fill("owner");
      await page.getByLabel(copy.password, { exact: true }).fill("disposable-password");
      await page.getByLabel(copy.repeat).fill("disposable-password");
      await page.getByLabel(copy.code, { exact: true }).fill("wrong-code");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      await page.getByRole("button", { name: copy.title, exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText(copy.wrong);
      await page.getByLabel(copy.code, { exact: true }).fill("abcd-efgh-jklm");
      await page.getByRole("button", { name: copy.title, exact: true }).click();
      await expect(page.getByRole("heading", { name: copy.title })).toHaveCount(0);
      expect(sent.map((body) => body.setupCode)).toEqual([
        "wrong-code",
        "abcd-efgh-jklm",
      ]);
    } finally {
      await application.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
