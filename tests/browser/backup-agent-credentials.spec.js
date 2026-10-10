import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

test.use({ locale: "en-GB" });

const note =
  "Agent credentials in this backup can only be restored on this host. Any credential or provider connection change makes them unreadable; agents then need to sign in again.";

async function review(page, withCredentials) {
  await page.goto(baseURL + "/settings/backups");
  await page.getByRole("button", { name: "Prepare backup", exact: true }).click();
  if (withCredentials)
    await page.getByLabel("Include encrypted credentials", { exact: true }).check();
  await page.getByRole("button", { name: "Review backup scope", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create backup" })).toBeVisible();
}

test("a credentialed backup with agents states the host-bound restore limit", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  state.assistants = true;
  await review(page, true);
  await expect(page.getByText(note, { exact: true })).toBeVisible();
});

test("backups without agent credentials show no agent credential note", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  state.assistants = true;
  await review(page, false);
  await expect(page.getByText(note, { exact: true })).toHaveCount(0);
});

test("backup rows show a readable size and only the options a backup has", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  state.backups = [
    {
      id: "plain",
      createdAt: "2026-09-07T12:00:00Z",
      bytes: 1209867,
      includeHistory: false,
      withCredentials: false,
    },
    {
      id: "full",
      createdAt: "2026-09-08T12:00:00Z",
      bytes: 4096,
      includeHistory: true,
      withCredentials: true,
    },
  ];
  await page.goto(baseURL + "/settings/backups");
  const rows = page.locator(".operations-card p");
  await expect(rows.nth(0)).toHaveText("1.2 MB");
  await expect(rows.nth(1)).toHaveText(
    "4 kB · Include history · Include encrypted credentials",
  );
});

test("the backup scope names provider connections in words", async ({ page }) => {
  const state = await operationsFixture(page);
  state.planComponents = ["provider-connections", "encrypted-provider-credentials"];
  await review(page, true);
  await expect(page.getByText("Provider connections", { exact: true })).toBeVisible();
  await expect(page.getByText("provider-connections")).toHaveCount(0);
});
