import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`remote settings ${locale}`, () => {
    test.use({ locale });
    test("network mode needs confirmation, saves hosts and offers a restart", async ({
      page,
    }) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      await page.goto(baseURL + "/settings/remote");
      await expect(page.getByText(en ? "Local" : "Lokal", { exact: true })).toBeVisible();
      await expect(
        page.getByText("http://127.0.0.1:4380", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("https://host.example.ts.net:8443", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("switch", { name: en ? "Network access" : "Netzwerkzugriff" })
        .click();
      await expect(page.getByText(en ? /unencrypted/ : /unverschlüsselt/)).toBeVisible();
      await page
        .getByRole("button", { name: en ? "Enable anyway" : "Trotzdem einschalten" })
        .click();
      const input = page.getByRole("textbox", {
        name: en ? "Additional host" : "Zusätzlicher Host",
      });
      await input.fill("agentpier.home.arpa");
      await page
        .getByRole("button", { name: en ? "Add host" : "Host hinzufügen" })
        .click();
      await page.getByRole("button", { name: en ? "Save" : "Speichern" }).click();
      const put = state.calls
        .filter((c) => c.method === "PUT" && c.path === "/remote")
        .at(-1);
      expect(put.body).toEqual({
        network: { enabled: true, bind: "0.0.0.0", hosts: ["agentpier.home.arpa"] },
      });
      await expect(
        page.getByText("http://agentpier.home.arpa:4380", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(en ? /Restart required/ : /Neustart erforderlich/),
      ).toBeVisible();
      await page
        .getByRole("button", { name: en ? "Restart service" : "Dienst neu starten" })
        .click();
      expect(
        state.calls.some((c) => c.method === "POST" && c.path === "/remote/restart"),
      ).toBe(true);
      await expect(
        page.getByText(en ? /Service restarted/ : /Dienst neu gestartet/),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
    });
    test("network access itself may only switch the mode off", async ({ page }) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      state.remote.network.locked = true;
      state.remote.network.saved.enabled = true;
      state.remote.network.running.enabled = true;
      await page.goto(baseURL + "/settings/remote");
      await expect(
        page.getByText(en ? /only be switched off/ : /nur ausgeschaltet/),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: en ? "Additional host" : "Zusätzlicher Host" }),
      ).toHaveCount(0);
      await page
        .getByRole("switch", { name: en ? "Network access" : "Netzwerkzugriff" })
        .click();
      await page.getByRole("button", { name: en ? "Save" : "Speichern" }).click();
      const put = state.calls
        .filter((c) => c.method === "PUT" && c.path === "/remote")
        .at(-1);
      expect(put.body.network.enabled).toBe(false);
    });
  });
}
