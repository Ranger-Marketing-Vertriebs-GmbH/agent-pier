import { expect } from "@playwright/test";

export function profileList(page, name = "CLI-Profile") {
  return page.getByRole("navigation", { name, exact: true });
}

export async function expectProfilesDisabled(page, name) {
  const buttons = profileList(page, name).getByRole("button");
  expect(await buttons.count()).toBeGreaterThan(0);
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
}

export async function openTab(page, name) {
  const tab = page.getByRole("tab", { name: new RegExp(`^${name}`) });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

// Mobile rows hide their actions behind a chevron; desktop rows show them directly.
export async function revealRow(page, row, label = "Aktionen für") {
  await expect(page.getByRole("heading", { name: row, exact: true })).toBeVisible();
  const toggle = page.getByRole("button", { name: `${label} ${row}`, exact: true });
  if (
    (await toggle.isVisible()) &&
    (await toggle.getAttribute("aria-expanded")) !== "true"
  )
    await toggle.click();
}

export async function expectNoHorizontalOverflow(page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
}

// The extensions page loads MCP/skills and plugins together, so plugin-focused
// fixtures still answer the extensions read with an empty inventory.
export function emptyExtensions(path = "/fixture/config") {
  return {
    mcp: { servers: [], path, note: "" },
    skills: { items: [], installPath: "/fixture/skills", note: "" },
  };
}

export function emptyAgency() {
  return {
    revision: "0".repeat(40),
    categories: [],
    items: [],
    installed: [],
    total: 0,
    page: 1,
    hasMore: false,
  };
}
