import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture } from "./projects-fixture.js";

const phone = { width: 390, height: 844 };
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const header = (page) => page.locator(".settings-shell-header");

test("phones show the projects header with the drawer button and an add menu", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await hubFixture(page);
  await page.goto(base + "/projects");
  await expect(
    header(page).getByRole("heading", { name: "Projekte", level: 1 }),
  ).toBeVisible();
  await expect(header(page).getByText("2 Projekte · Lokal gespeichert")).toBeVisible();
  await expect(page.locator(".mobile-header")).toBeHidden();
  const drawer = header(page).getByRole("button", { name: "Navigation öffnen" });
  await expect(drawer).toHaveAttribute("aria-expanded", "false");
  await drawer.click();
  await expect(drawer).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveAttribute("aria-expanded", "false");

  const add = header(page).getByRole("button", { name: "Projekt hinzufügen" });
  await expect(add).toHaveAttribute("aria-haspopup", "menu");
  await add.click();
  const menu = page.getByRole("menu", { name: "Projekt hinzufügen" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Repository klonen",
    "Ordner hinzufügen",
  ]);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  await header(page).getByRole("heading", { level: 1 }).click();
  await expect(menu).toHaveCount(0);
  await add.click();
  await menu.getByRole("menuitem", { name: "Ordner hinzufügen" }).click();
  await expect(page.getByRole("dialog", { name: "Projekt hinzufügen" })).toBeVisible();
  await page.getByRole("button", { name: "Dialog schließen" }).click();
  await expect(add).toBeFocused();
  await add.click();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  expect(await noOverflow(page)).toBe(true);
});

test("a project on a phone has a back header, four fitting tabs and the launch bar", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await hubFixture(page);
  await page.goto(base + "/projects/m1");
  await expect(
    header(page).getByRole("heading", { name: "agent-pier", level: 1 }),
  ).toBeVisible();
  await expect(header(page).getByText("acme/agent-pier · Token Arbeit")).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "Projektbereiche" });
  await expect(tabs.getByRole("tab")).toHaveText([
    /^Übersicht/,
    /^Wissen\s*4/,
    /^AgentBus\s*1/,
    /^Läufe\s*3/,
  ]);
  await expect(tabs).not.toHaveClass(/can-scroll-right/);
  const launch = page.getByRole("button", { name: "Sitzung in agent-pier starten" });
  for (const tab of ["Übersicht", "Wissen", "AgentBus", "Läufe"]) {
    await tabs.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
    await expect(launch).toBeVisible();
    const box = await launch.boundingBox();
    expect(Math.round(box.height)).toBe(44);
    expect(box.y + box.height).toBeGreaterThan(800);
    // Projects has no draft fields: its bar is the launch bar, never a save bar.
    await expect(
      page.getByRole("region", { name: "Ungespeicherte Änderungen" }),
    ).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
  }
  await header(page).getByRole("button", { name: "Alle Projekte" }).click();
  // `choose("")` keeps the last tab for the next project (unchanged behaviour), so the
  // list address carries it after the loop ended on "Läufe".
  await expect(page).toHaveURL(/\/projects\?tab=runs$/);
  await expect(
    page.getByRole("navigation", { name: "Projekte", exact: true }),
  ).toBeVisible();
});

test("an unknown project on a phone keeps a way back", async ({ page }) => {
  await page.setViewportSize(phone);
  await hubFixture(page);
  await page.goto(base + "/projects/unknown-project");
  await expect(
    page.getByRole("heading", { name: "Projekt nicht gefunden" }),
  ).toBeVisible();
  await header(page).getByRole("button", { name: "Alle Projekte" }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test("the desktop header carries the add actions and the detail pane its launch button", async ({
  page,
}) => {
  await hubFixture(page);
  await page.goto(base + "/projects");
  await expect(page).toHaveURL(/\/projects\/m1$/);
  await expect(
    header(page).getByRole("heading", { name: "Projekte", level: 1 }),
  ).toBeVisible();
  await expect(
    header(page).getByText("Vom Repository zur nächsten Sitzung.", { exact: false }),
  ).toBeVisible();
  await expect(
    header(page).getByRole("button", { name: "Ordner hinzufügen" }),
  ).toBeVisible();
  await expect(
    header(page).getByRole("button", { name: "Repository klonen", exact: true }),
  ).toBeVisible();
  await expect(
    header(page).getByRole("button", { name: "Projekt hinzufügen" }),
  ).toHaveCount(0);
  await expect(
    header(page).getByRole("button", { name: "Navigation öffnen" }),
  ).toBeHidden();
  const card = page.locator(".project-card");
  await expect(card.getByRole("heading", { name: "agent-pier", level: 2 })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Sitzung in agent-pier starten" }),
  ).toBeVisible();
  await expect(page.locator(".project-launch-bar")).toHaveCount(0);
});

test("switching between phone and desktop width keeps the project, tab and filter", async ({
  page,
}) => {
  await hubFixture(page);
  await page.goto(base + "/projects/m1?tab=runs&status=running");
  const runs = page.getByRole("tab", { name: /^Läufe/ });
  await expect(runs).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize(phone);
  await expect(page.getByRole("heading", { name: "agent-pier", level: 1 })).toBeVisible();
  await expect(runs).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/projects\/m1\?tab=runs&status=running$/);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("heading", { name: "agent-pier", level: 2 })).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=runs&status=running$/);
});

test.describe("English projects shell", () => {
  test.use({ locale: "en-GB" });

  test("header, menu, back and launch are translated", async ({ page }) => {
    await page.setViewportSize(phone);
    await hubFixture(page);
    await page.goto(base + "/projects");
    await expect(header(page).getByText("2 projects · Stored locally")).toBeVisible();
    await header(page).getByRole("button", { name: "Add project" }).click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "Clone repository",
      "Add folder",
    ]);
    await page.keyboard.press("Escape");
    await page
      .getByRole("navigation", { name: "Projects", exact: true })
      .getByRole("button", { name: /^agent-pier/ })
      .click();
    await expect(page.getByRole("tab", { name: /^Knowledge/ })).toBeVisible();
    await expect(
      header(page).getByRole("button", { name: "All projects" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start session in agent-pier" }),
    ).toBeVisible();
  });
});

test("the update notice drops the hidden app header's offset on phones", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await hubFixture(page);
  await page.goto(base + "/projects");
  await expect(
    header(page).getByRole("heading", { name: "Projekte", level: 1 }),
  ).toBeVisible();
  await expect(page.locator(".mobile-header")).toHaveCount(1);
  await expect(page.locator(".mobile-header")).toBeHidden();
  await page.evaluate(() => dispatchEvent(new Event("agentpier-update-available")));
  const notice = page.locator(".update-notice");
  await expect(notice).toBeVisible();
  expect((await notice.boundingBox()).y).toBe(8);
});

test("the phone subtitle shows no fake zero when every source fails", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await hubFixture(page, {
    intercept: (route, url) =>
      ["/api/repositories", "/api/memory/projects", "/api/agentbus"].includes(
        url.pathname,
      ) &&
      route
        .fulfill({ status: 503, json: { error: "Nicht erreichbar" } })
        .then(() => true),
  });
  await page.goto(base + "/projects");
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(header(page).getByText("— · Lokal gespeichert")).toBeVisible();
  await expect(header(page).getByText("0 Projekte")).toHaveCount(0);
});
