import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setup } from "./assistant-teams-fixture.js";

// Agenten (handoff 5.2): the hub's four tabs with their counts, the teams of all
// leads with their actions, the Agency templates and the runtime.
const revision = "b".repeat(40);
const entries = {
  engineering__sre: {
    id: "engineering__sre",
    name: "SRE",
    category: "engineering",
    description: "Keeps systems running",
    revision,
    source: `https://github.com/msitarzewski/agency-agents/blob/${revision}/engineering/sre.md`,
    license: "MIT",
    verdict: "ok",
    findings: [],
    instructions: "Keeps systems running",
  },
  design__growth: {
    id: "design__growth",
    name: "Growth Hacker",
    category: "marketing",
    description: "Grows",
    revision,
    source: `https://github.com/msitarzewski/agency-agents/blob/${revision}/marketing/growth.md`,
    license: "MIT",
    verdict: "block",
    findings: [],
    instructions: "Grows",
  },
};
async function catalog(page) {
  const asked = [];
  await page.route(/\/api\/agency\/templates/, (route) => {
    const url = new URL(route.request().url());
    asked.push(url.search);
    if (url.pathname.endsWith("/preview"))
      return route.fulfill({ json: entries[url.searchParams.get("id")] });
    const items = Object.values(entries).map(({ id, name, category }) => ({
      id,
      name,
      category,
    }));
    return route.fulfill({
      json: { revision, total: 142, page: 1, hasMore: false, categories: [], items },
    });
  });
  return asked;
}
const tab = (page, name) => page.getByRole("tab", { name: new RegExp(`^${name}`) });

test("the hub's tabs render, count and deep-link", async ({ page }) => {
  await setup(page);
  await catalog(page);
  await page.goto(baseURL + "/agents");
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  await expect(tab(page, "All agents")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "All agents")).toContainText("1");
  await expect(tab(page, "Teams")).toContainText("2");
  await expect(page.getByRole("heading", { name: /Your agents/ })).toBeVisible();
  await expect(page.getByText("Agent service: Ready")).toBeVisible();
  for (const [name, path, marker] of [
    ["Teams", "/agents?tab=teams", /^Proposals/],
    ["Templates", "/agents?tab=templates", /^Catalog · 142/],
    ["Runtime", "/agents?tab=runtime", /^Function$/],
  ]) {
    await page.goto(baseURL + path);
    await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(marker).first()).toBeVisible();
  }
  await tab(page, "All agents").click();
  await expect(page).toHaveURL(/\/agents$/);
  await page.getByRole("link", { name: "From template" }).click();
  await expect(page).toHaveURL(/\/agents\?tab=templates$/);
  await page.getByRole("link", { name: "New agent" }).click();
  await expect(page).toHaveURL(/\/agents\?new=1$/);
});

test("the Teams tab shows every lead's teams with their actions", async ({ page }) => {
  const { teams, teamSettings } = await setup(page);
  teamSettings.hostMaxConcurrent = 6;
  await page.goto(baseURL + "/agents?tab=teams");
  await expect(page.getByRole("heading", { name: "Lead Home assistant" })).toBeVisible();
  await expect(page.getByText("Review the project")).toBeVisible();
  await expect(
    page.getByText("Concurrently active members on this host: 6"),
  ).toBeVisible();
  // A proposal is decided here as in the lead's Team tab.
  await page.getByRole("button", { name: "Decline team", exact: true }).click();
  await expect.poll(() => teams.find((t) => t.id === "proposal").phase).toBe("declined");
  await page.getByRole("link", { name: "change the limit" }).click();
  await expect(page).toHaveURL(/\/agents\?tab=runtime$/);
  await expect(page.getByLabel("Concurrent members on this host")).toHaveValue("6");
});

test("templates offer both uses; a blocked entry offers none", async ({ page }) => {
  await setup(page);
  await catalog(page);
  await page.goto(baseURL + "/agents?tab=templates");
  await page.getByRole("button", { name: /^SRE/ }).click();
  const preview = page.getByRole("dialog", { name: "SRE" });
  await expect(preview).toContainText("Checked");
  await expect(preview.getByRole("link", { name: "Source on GitHub" })).toBeVisible();
  await expect(preview).toContainText("MIT license");
  await expect(
    preview.getByRole("link", { name: "Install as subagent in a CLI …" }),
    // Coding › Unteragenten reads `install=<entry>` once that page knows it.
  ).toHaveAttribute(
    "href",
    /^\/coding\/clis\/extensions\?tab=subagents(&install=engineering__sre)?$/,
  );
  await preview.getByRole("link", { name: "Create personal agent" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/agents\\?new=1&template=engineering__sre&revision=${revision}$`),
  );
  await page.goto(baseURL + "/agents?tab=templates");
  await page.getByRole("button", { name: /^Growth Hacker/ }).click();
  const blocked = page.getByRole("dialog", { name: "Growth Hacker" });
  await expect(blocked).toContainText("This entry is blocked and cannot be used.");
  await expect(blocked.getByRole("link", { name: "Create personal agent" })).toHaveCount(
    0,
  );
  await expect(
    blocked.getByRole("link", { name: "Install as subagent in a CLI …" }),
  ).toHaveCount(0);
});

test("Runtime holds the agent service, updates, teams, dreaming, advanced and storage", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + "/agents?tab=runtime");
  await expect(page.getByRole("switch", { name: "Enable agents" })).toBeChecked();
  await expect(page.getByText("Agent diagnostic", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart service" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop service" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "OpenClaw updates" })).toBeVisible();
  await expect(page.getByLabel("Concurrent members on this host")).toBeVisible();
  await expect(page.getByRole("region", { name: "Dreaming" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Advanced · for all agents" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Storage" })).toBeVisible();
  await page
    .getByRole("button", { name: "Installed agent dependencies: Clean up …" })
    .click();
});

test("phones show the hub in one column", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/agents", "/agents?tab=teams", "/agents?tab=runtime"]) {
    await page.goto(baseURL + path);
    await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  }
  // The whole row opens the agent's settings.
  await page.goto(baseURL + "/agents");
  await page.getByRole("link", { name: /Home assistant/ }).click();
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
});
