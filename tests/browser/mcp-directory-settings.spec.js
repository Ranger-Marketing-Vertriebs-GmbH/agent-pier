import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { settingsBar } from "../helpers/settings.js";
import { operationsFixture } from "./operations-fixture.js";

const official = "https://registry.modelcontextprotocol.io";

async function setup(page) {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = await operationsFixture(page);
  state.preferences = { mcpDirectory: { enabled: true, baseUrl: official } };
  // An address the server refuses (registered later, so it is asked first).
  await page.route("**/api/preferences", (route) =>
    route.request().postDataJSON()?.mcpDirectory?.baseUrl === "http://example.test"
      ? route.fulfill({
          status: 400,
          json: {
            code: "MCP_DIRECTORY_INVALID_SETTINGS",
            error:
              "Bitte eine https-Adresse ohne Zugangsdaten, Abfrage oder Fragment angeben (http nur auf diesem Rechner).",
            messageKey: "mcpDirectory.invalidSettings",
          },
        })
      : route.fallback(),
  );
  return state;
}
const patches = (state) =>
  state.calls.filter((call) => call.method === "PATCH" && call.path === "/preferences");

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(`mcp directory settings ${label}`, () => {
    test.use(use);

    test("the directory can be turned off and pointed at another registry", async ({
      page,
    }) => {
      const state = await setup(page);
      await page.goto(`${baseURL}/settings`);
      const toggle = page.getByRole("switch", { name: "Search the MCP Registry" });
      await expect(toggle).toBeChecked();
      await toggle.click();
      await page.getByText("Advanced", { exact: true }).click();
      await page.getByLabel("Registry address").fill("https://mirror.example.test/");
      await settingsBar(page).getByRole("button", { name: /^Save/ }).click();
      await expect.poll(() => patches(state).length).toBe(1);
      expect(patches(state)[0].body).toEqual({
        mcpDirectory: { enabled: false, baseUrl: "https://mirror.example.test/" },
      });
    });

    test("a refused address is named at the field in English", async ({ page }) => {
      const state = await setup(page);
      await page.goto(`${baseURL}/settings`);
      await page.getByText("Advanced", { exact: true }).click();
      const field = page.getByLabel("Registry address");
      await field.fill("http://example.test");
      await settingsBar(page).getByRole("button", { name: /^Save/ }).click();
      await expect(page.getByRole("alert")).toHaveText(
        "Enter an https address without credentials, query or fragment (http only on this computer).",
      );
      await expect(field).toHaveAttribute("aria-invalid", "true");
      expect(patches(state)).toEqual([]);
      // The official registry comes back with one action, and the error goes.
      await page.getByRole("button", { name: "Use the official registry" }).click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(field).toHaveValue(official);
    });
  });
}
