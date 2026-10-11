import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

const lead = {
  id: "lead",
  name: "Chief of Staff with a deliberately long agent name",
  model: { connectionId: "router", modelId: "google/gemini-3.8-flash" },
  revision: 1,
};
const scout = {
  ...lead,
  id: "scout",
  name: "Recherche-Lead",
  teamMemberId: "m1",
  parentAssistantId: "lead",
  lifetime: "task",
  teamId: "t1",
};
async function fixture(page, activity) {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/assistant-feature")
      return route.fulfill({ json: { enabled: true, error: null } });
    if (path === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [lead, scout],
          conversations: [],
          models: [{ id: "router", name: "OpenRouter", available: true }],
          teams: [
            {
              id: "t1",
              parentAssistantId: "lead",
              objective: "Prepare the relaunch",
              phase: "running",
              members: [],
              memberIds: ["m1"],
            },
          ],
          members: [
            {
              id: "m1",
              teamId: "t1",
              assistantId: "scout",
              name: "Recherche-Lead",
              role: "Research",
              assignment: "Review competitor pages",
              phase: "running",
              lifetime: "task",
            },
          ],
          policies: {},
          teamSettings: { revision: 0, hostMaxConcurrent: 8 },
          ...(activity ? { activity } : {}),
        },
      });
    return route.fallback();
  });
}

test("agent rows show activity, a team pill and truncate long English copy", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, {
    lead: {
      state: "working",
      reason: "team",
      label: "teamActive.working",
      pendingApprovals: 0,
      team: "active",
    },
  });
  await page.goto(baseURL);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const row = page.locator(".assistant-sidebar-row").first();
  await expect(row.locator(".activity-dot")).toHaveClass(/working/);
  await expect(row.locator(".assistant-sidebar-item small").first()).toHaveText(
    "Team working",
  );
  const name = row.locator("strong").first();
  expect(await name.evaluate((n) => n.scrollWidth > n.clientWidth)).toBe(true);
  await expect(name).toHaveCSS("text-overflow", "ellipsis");
  const pill = row.getByRole("button", { name: /Show team members \(1\)/ });
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await pill.click();
  await expect(
    row.getByRole("button", { name: /Hide team members \(1\)/ }),
  ).toHaveAttribute("aria-expanded", "true");
  const group = page.getByRole("group", { name: "Prepare the relaunch" });
  await expect(group.locator(".assistant-sidebar-member")).toHaveCount(1);
  await expect(
    group.getByRole("button", { name: /^Recherche-Lead, / }),
  ).toHaveAccessibleDescription("Review competitor pages");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("the agent group does not add a second scroller inside the sidebar", async ({
  page,
}) => {
  await fixture(page, undefined);
  await page.goto(baseURL);
  await expect(page.locator(".assistant-sidebar-row").first()).toBeVisible();
  const content = page.locator(".assistant-chats-group > .sidebar-group-content");
  await expect(content).toHaveCSS("overflow-y", "visible");
  const scrollers = await page.evaluate(() =>
    [...document.querySelectorAll(".sidebar *")]
      .filter((el) => !el.classList.contains("sidebar-scroll"))
      .filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY))
      .filter((el) => el.scrollHeight > el.clientHeight)
      .map((el) => el.className),
  );
  expect(scrollers).toEqual([]);
});

test("a list response without activity renders idle rows", async ({ page }) => {
  await fixture(page, undefined);
  await page.goto(baseURL);
  const row = page.locator(".assistant-sidebar-row").first();
  await expect(row).toBeVisible();
  await expect(row.locator(".activity-dot")).toHaveCount(0);
  await expect(row.locator(".assistant-sidebar-item small").first()).toHaveText(
    "google/gemini-3.8-flash",
  );
});
