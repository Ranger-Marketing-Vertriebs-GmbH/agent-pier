import { test, expect } from "../helpers/browser-test.js";
import { fixture } from "./providers-fixture.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { settingsPath } from "../helpers/agent-settings-page.js";

test("owner confirms a global browser policy and sees pending activation and revocation", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  let network = { revision: 0, allowPrivateNetwork: false, active: false };
  const puts = [];
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/assistant-browser-network") {
      const body = route.request().postDataJSON();
      puts.push(body);
      network = {
        ...network,
        allowPrivateNetwork: body.allowPrivateNetwork,
        revision: network.revision + 1,
      };
      return route.fulfill({ json: network });
    }
    if (pathname === "/api/assistant-runtime")
      return route.fulfill({
        json: {
          availability: "ready",
          sync: "current",
          browser: { available: true, network },
        },
      });
    if (pathname === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [
            {
              id: "home",
              name: "Home",
              instructions: "",
              revision: 1,
              effectiveRevision: 1,
              model: { connectionId: "router", modelId: "model" },
              capabilities: { memory: false, reminders: false, browser: true },
            },
          ],
          conversations: [],
          models: [],
        },
      });
    if (pathname === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(settingsPath("capabilities"));
  const toggle = page.getByRole("switch", {
    name: "Allow private networks for all agent browsers",
    exact: true,
  });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("cloud metadata");
  await expect(dialog).toContainText("browser sandbox remains enabled");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(puts).toHaveLength(0);
  await toggle.click();
  await dialog.getByRole("button", { name: "Save global setting" }).click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText(/Saved: allowed\. Restart pending/)).toBeVisible();
  expect(puts[0]).toEqual({
    revision: 0,
    allowPrivateNetwork: true,
    confirmRestart: true,
  });
  const screenshot = testInfo.outputPath("global-browser-network.png");
  await page
    .getByRole("region", { name: "Agent browser", exact: true })
    .screenshot({ path: screenshot });
  await testInfo.attach("global-browser-network", {
    path: screenshot,
    contentType: "image/png",
  });
  network.active = true;
  await page.reload();
  await expect(page.getByText(/Active: private network access allowed/)).toBeVisible();
  await toggle.click();
  await dialog.getByRole("button", { name: "Save global setting" }).click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText(/Saved: blocked\. Restart pending/)).toBeVisible();
  expect(puts[1].allowPrivateNetwork).toBe(false);
});
