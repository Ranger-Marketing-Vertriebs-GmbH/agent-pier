import { expect } from "@playwright/test";

export function profileList(page, name = "CLI-Profile") {
  return page.getByRole("navigation", { name, exact: true });
}

const profileSwitch = /^(CLI-Profil wechseln|Switch CLI profile)/;

// Desktop lists CLI profiles in a column; phones open them from the header subtitle as
// a sheet. Returns the group of profile buttons in either case.
export async function openProfiles(page, name = "CLI-Profile") {
  const switcher = page.getByRole("button", { name: profileSwitch });
  await expect(
    switcher.or(profileList(page, name)).filter({ visible: true }),
  ).toHaveCount(1);
  if (!(await switcher.isVisible())) return profileList(page, name);
  await switcher.click();
  return page
    .getByRole("dialog", { name, exact: true })
    .getByRole("group", { name, exact: true });
}

export async function closeProfiles(page) {
  if (await page.locator("dialog.extension-profile-sheet").isVisible())
    await page.keyboard.press("Escape");
}

export async function expectProfilesDisabled(page, name) {
  const switcher = page.getByRole("button", { name: profileSwitch });
  if (await switcher.isVisible()) return expect(switcher).toBeDisabled();
  const buttons = profileList(page, name).getByRole("button");
  expect(await buttons.count()).toBeGreaterThan(0);
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
}

export async function openTab(page, name) {
  const tab = page.getByRole("tab", { name: new RegExp(`^${name}`) });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

// Rows show their actions directly; wait until the row is there.
export async function revealRow(page, row) {
  await expect(extensionRow(page, row)).toBeVisible();
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

const exactText = (text) =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

// A list row by its exact label; `scope` is the page or a locator inside it.
export function extensionRow(scope, name) {
  const page = typeof scope.page === "function" ? scope.page() : scope;
  return scope
    .locator(".list-row")
    .filter({ has: page.locator(".list-row-label", { hasText: exactText(name) }) });
}

// Desktop rows keep their actions in a ⋯ menu; open it when the item is not shown yet.
export async function rowMenuItem(page, row, name) {
  const item = page.getByRole("menuitem", { name, exact: true });
  if (!(await item.isVisible()))
    await extensionRow(page, row)
      .getByRole("button", { name: /^(Aktionen für|Actions for) / })
      .click();
  return item;
}
