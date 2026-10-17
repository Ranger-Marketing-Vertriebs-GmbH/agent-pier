import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";

// The dashboard card of the managed agent browser: version, update and removal.
async function fixture(page) {
  const state = {
    tools: [{ id: "claude", name: "Claude Code", installed: true }],
    utilities: [
      {
        id: "chromium",
        name: "Chrome for Testing",
        utility: true,
        installed: true,
        version: "155.0.8059.84",
        pinnedVersion: "156.0.1.2",
        updateAvailable: true,
      },
    ],
    accounts: [],
    sessions: [],
    home: "/home/server",
    remoteUrl: null,
  };
  const job = {
    tool: "chromium",
    name: "Chrome for Testing",
    packageName: "Chrome for Testing 156.0.1.2",
    installer: "chrome-for-testing",
    utility: true,
    status: "idle",
    available: true,
    installed: true,
    installedVersion: "155.0.8059.84",
    pinnedVersion: "156.0.1.2",
    updateAvailable: true,
    updateCommand: "Chrome for Testing 156.0.1.2",
    removable: true,
    destination: "/data/clis/chromium",
    message: "",
  };
  const controls = { state, removes: 0, updates: 0 };
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/tool-installations")
      return route.fulfill({ json: { installations: [job], busy: false } });
    if (path === "/api/tools/chromium/update") {
      controls.updates++;
      Object.assign(job, { status: "running", operation: "update" });
      return route.fulfill({ status: 202, json: job });
    }
    if (path === "/api/tools/chromium" && request.method() === "DELETE") {
      controls.removes++;
      state.utilities[0] = { ...state.utilities[0], installed: false, version: null };
      return route.fulfill({ json: { ...job, installed: false } });
    }
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(base);
  return controls;
}
const card = (page) =>
  page.locator(".tool-card").filter({
    has: page.getByRole("heading", { name: "Chrome for Testing", exact: true }),
  });

test("the managed browser card updates and removes Chrome for Testing", async ({
  page,
}) => {
  const controls = await fixture(page);
  await expect(card(page)).toContainText("155.0.8059.84");
  await card(page).getByRole("button", { name: "Update CLI" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Installed: 155.0.8059.84 · Available: 156.0.1.2");
  await dialog.getByRole("button", { name: "Update now" }).click();
  await expect.poll(() => controls.updates).toBe(1);
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await card(page).getByRole("button", { name: "Remove" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Remove/ })
    .click();
  await expect.poll(() => controls.removes).toBe(1);
});
