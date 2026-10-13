import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture } from "./projects-fixture.js";

const phone = { width: 390, height: 844 };
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const panel = (page) => page.getByRole("tabpanel");

test("attention strips open the single run or the filtered run list", async ({
  page,
}) => {
  await hubFixture(page);
  await page.goto(base + "/projects/m1");
  const decision = panel(page).getByRole("button", {
    name: "1 Entscheidung erforderlich",
    exact: true,
  });
  await expect(decision).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /fehlgeschlagen/ })).toHaveCount(
    0,
  );
  await decision.click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/a$/);

  await page.goto(base + "/projects/m2");
  await panel(page)
    .getByRole("button", { name: "2 Läufe fehlgeschlagen", exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\/m2\?tab=runs&status=failed$/);
  await expect(
    page
      .getByRole("group", { name: "Status", exact: true })
      .getByRole("button", { name: /^Fehlgeschlagen/ }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("the overview shows facts and sessions as list cards", async ({ page }) => {
  await page.setViewportSize(phone);
  await hubFixture(page);
  await page.goto(base + "/projects/m1");
  await expect(page.getByRole("heading", { name: "Projektdetails" })).toBeVisible();
  await expect(page.getByRole("definition").first()).toHaveText(
    "github.com/acme/agent-pier",
  );
  await expect(
    page.getByRole("heading", { name: "Sitzungen · 1", level: 2 }),
  ).toBeVisible();
  const sessionList = page.getByRole("list", { name: "Sitzungen · 1" });
  await expect(sessionList.getByRole("listitem")).toHaveCount(1);
  const row = sessionList.getByRole("button", {
    name: "Sitzung Hub fixture session öffnen",
  });
  await expect(row).toHaveAccessibleDescription("Codex · vor 5 Minuten Läuft");
  await row.click();
  await expect(page).toHaveURL(/\/sessions\/s1\//);
});

test("the facts card shows a long folder path in full on phones", async ({ page }) => {
  await page.setViewportSize(phone);
  const loosePath =
    "/Users/someone/Projects/agent-pier/.worktrees/settings-redesign-projects/nested/folder";
  await hubFixture(page, { unregistered: true, loosePath });
  await page.goto(base + "/projects/r2");
  const folder = page.getByRole("definition").filter({ hasText: loosePath });
  await expect(folder).toHaveText(loosePath);
  await expect(folder).not.toHaveAttribute("title");
  expect(await folder.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
    true,
  );
  expect(await noOverflow(page)).toBe(true);
});

test("a project without knowledge registration shows no attention strip", async ({
  page,
}) => {
  await hubFixture(page, { unregistered: true });
  await page.goto(base + "/projects/r2");
  await expect(page.getByRole("heading", { name: "loose", level: 2 })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sitzungen · 0", level: 3 }),
  ).toBeVisible();
  await expect(page.locator(".project-attention")).toHaveCount(0);
  await expect(page.getByRole("definition").first()).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
});

test("the knowledge hint is a disclosure and the entry filter a deep-linked radio group", async ({
  page,
}) => {
  await hubFixture(page);
  await page.goto(base + "/projects/m1?tab=knowledge&archived=1");
  await expect(page.getByRole("tab", { name: /^Wissen/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const filter = page.getByRole("radiogroup", { name: "Wissenseinträge" });
  await expect(filter.getByRole("radio", { name: /^Archiv/ })).toBeChecked();
  const info = panel(page).getByRole("button", { name: "Hinweis anzeigen" });
  await expect(info).toHaveAttribute("aria-expanded", "false");
  const hint = page.locator(`[id="${await info.getAttribute("aria-controls")}"]`);
  await expect(hint).toBeHidden();
  await info.click();
  await expect(info).toHaveAttribute("aria-expanded", "true");
  await expect(hint).toHaveText(
    "Git-Worktrees teilen das Repository-Wissen. Andere Projekte bleiben getrennt. Einträge sind geteilte Notizen, keine automatisch geprüften Anweisungen.",
  );
  await info.click();
  await expect(hint).toBeHidden();
  await filter.getByRole("radio", { name: /^Aktiv/ }).check();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=knowledge$/);
  await page.goBack();
  await expect(filter.getByRole("radio", { name: /^Archiv/ })).toBeChecked();
  await page.getByRole("button", { name: "Neuer Eintrag" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("the knowledge entries label is an h2 below the phone page title", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await hubFixture(page);
  await page.goto(base + "/projects/m1?tab=knowledge");
  await expect(
    page.getByRole("heading", { name: "Wissenseinträge", level: 2 }),
  ).toBeVisible();
});

test("a typed search and a tab switch never ask to save", async ({ page }) => {
  await hubFixture(page);
  await page.goto(base + "/projects/m1?tab=knowledge");
  await page.getByRole("textbox", { name: "Wissen suchen" }).fill("unsent");
  await page.getByRole("tab", { name: /^AgentBus/ }).click();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=agentbus$/);
  await expect(page.getByRole("dialog", { name: "Änderungen speichern?" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("region", { name: "Ungespeicherte Änderungen" }),
  ).toHaveCount(0);
});

test.describe("English knowledge tab pattern", () => {
  test.use({ locale: "en-GB" });

  test("hint, filter and new entry are translated on phones", async ({ page }) => {
    await page.setViewportSize(phone);
    await hubFixture(page);
    await page.goto(base + "/projects/m1?tab=knowledge");
    const filter = page.getByRole("radiogroup", { name: "Knowledge entries" });
    await expect(filter.getByRole("radio", { name: /^Active/ })).toBeChecked();
    await panel(page).getByRole("button", { name: "Show hint" }).click();
    await expect(
      page.getByText(/Git worktrees share repository knowledge/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "New entry" })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
  });
});

const emptyMessages = async (route, url) => {
  if (!url.pathname.endsWith("/messages")) return false;
  await route.fulfill({ json: { items: [], page: 1, pageSize: 20, total: 0 } });
  return true;
};

test("the AgentBus view switch is a radio group bound to the address", async ({
  page,
}) => {
  await hubFixture(page, { intercept: emptyMessages });
  await page.goto(base + "/projects/m1?tab=agentbus&bus=messages");
  const view = page.getByRole("radiogroup", { name: "AgentBus-Ansicht" });
  await expect(view.getByRole("radio", { name: /^Nachrichten/ })).toBeChecked();
  await expect(
    page.getByText("0 verbunden · 0 Nachrichten warten · Version test"),
  ).toBeVisible();
  await view.getByRole("radio", { name: /^Sitzungen/ }).check();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=agentbus$/);
  await expect(
    page.getByRole("heading", { name: "0 verbunden", level: 3 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Hub fixture session", level: 4 }),
  ).toBeVisible();
  await expect(page.getByText("0 Nachrichten warten · Version test")).toBeVisible();
  await expect(
    page.getByRole("article").filter({ hasText: "Hub fixture session" }),
  ).toBeVisible();
  await page.goBack();
  await expect(view.getByRole("radio", { name: /^Nachrichten/ })).toBeChecked();
});

test.describe("English AgentBus pattern", () => {
  test.use({ locale: "en-GB" });

  test("the view switch and counts are translated on phones", async ({ page }) => {
    await page.setViewportSize(phone);
    await hubFixture(page, { intercept: emptyMessages });
    await page.goto(base + "/projects/m1?tab=agentbus");
    const view = page.getByRole("radiogroup", { name: "AgentBus view" });
    await expect(view.getByRole("radio", { name: /^Sessions · 1/ })).toBeChecked();
    await expect(
      page.getByRole("heading", { name: "0 connected", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Hub fixture session", level: 3 }),
    ).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
  });
});

test("run filter chips are pills that fade at the hidden edge on phones", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await hubFixture(page);
  await page.goto(base + "/projects/m1?tab=runs");
  const filter = page.getByRole("group", { name: "Status", exact: true });
  await expect(filter.getByRole("button")).toHaveCount(4);
  await expect(filter.getByRole("button").first()).toHaveCSS("border-radius", "999px");
  await expect(filter.getByRole("button").first()).toHaveCSS("height", "32px");
  await expect(filter).toHaveClass(/can-scroll-right/);
  await filter.getByRole("button", { name: /^Abgeschlossen/ }).click();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=runs&status=completed$/);
  await expect(filter).toHaveClass(/can-scroll-left/);
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: /^Lauf öffnen:/ }) })
    .first();
  const title = await row.locator(".run-table-title").boundingBox();
  const status = await row.locator(".run-table-status").boundingBox();
  expect(status.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
  await expect(
    page.getByRole("button", { name: "Lauf starten", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Aktualisieren", exact: true }),
  ).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
});
