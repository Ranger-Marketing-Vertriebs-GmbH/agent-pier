import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings as setup } from "../helpers/assistant-settings-browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";
import { catalog, nas, opnsense } from "./assistant-ssh-fixture.js";

const row = (page) => page.getByRole("link", { name: /^SSH accesses/ });
const save = (page) => saveBar(page).getByRole("button", { name: "Save", exact: true });
const back = (page) => page.getByRole("button", { name: "Back to Work" });

test("SSH accesses are picked with a mode and saved with the Work tab", async ({
  page,
}) => {
  const state = await setup(page, { catalog: catalog() });
  await page.goto(baseURL + settingsPath("work"));
  await expect(row(page)).toContainText("None");
  await row(page).click();
  await expect(page.getByText("Project: Homelab")).toBeVisible();
  await expect(page.getByText("admin@nas.invalid:2222")).toBeVisible();
  await page.getByLabel("Search hosts").fill("opn");
  await expect(page.getByLabel("nas-01", { exact: true })).toHaveCount(0);
  await page.getByLabel("opnsense", { exact: true }).check();
  const modes = page.getByRole("group", { name: "Mode" });
  await expect(modes.getByRole("radio", { name: /^With approval/ })).toBeChecked();
  await expect(page.getByText(/could run without your confirmation/)).toHaveCount(0);
  await modes.getByRole("radio", { name: /^Trusted Runs/ }).check();
  await expect(page.getByText(/could run without your confirmation/)).toBeVisible();
  await back(page).click();
  await expect(row(page)).toContainText("1 host · 1 trusted");
  await save(page).click();
  await expect.poll(() => state.work.length).toBe(1);
  expect(state.work[0].access.sshAccesses).toEqual([
    { accessId: opnsense.id, mode: "trusted" },
  ]);
});

test("an empty catalog links to the SSH settings", async ({ page }) => {
  await setup(page, { catalog: catalog([]) });
  await page.goto(baseURL + settingsPath("work", "ssh"));
  await expect(page.getByText("There are no SSH accesses yet.")).toBeVisible();
  await page.getByRole("button", { name: "Set up SSH accesses" }).click();
  await expect(page).toHaveURL(/settings/);
  await expect(page).not.toHaveURL(/agents\/home/);
});

test("a removed host is marked and dropped on the next save", async ({ page }) => {
  const gone = "33333333-3333-4333-8333-333333333333";
  const state = await setup(page, {
    catalog: catalog([opnsense]),
    access: { revision: 0, sshAccesses: [{ accessId: gone, mode: "approval" }] },
  });
  await page.goto(baseURL + settingsPath("work", "ssh"));
  await expect(page.getByText("Host removed")).toBeVisible();
  await page.getByLabel("opnsense", { exact: true }).check();
  await save(page).click();
  await expect.poll(() => state.work.length).toBe(1);
  expect(state.work[0].access.sshAccesses).toEqual([
    { accessId: opnsense.id, mode: "approval" },
  ]);
});

test("an unreadable SSH catalog shows an error with retry", async ({ page }) => {
  const state = await setup(page, { catalog: catalog(null) });
  await page.goto(baseURL + settingsPath("work", "ssh"));
  await expect(page.getByText("SSH accesses could not be loaded.")).toBeVisible();
  state.catalog = catalog([opnsense]);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByLabel("opnsense", { exact: true })).toBeVisible();
});

test("a conflicting SSH change elsewhere is named", async ({ page }) => {
  const state = await setup(page, { catalog: catalog() });
  await page.goto(baseURL + settingsPath("work", "ssh"));
  await page.getByLabel("opnsense", { exact: true }).check();
  state.access = { revision: 1, sshAccesses: [{ accessId: nas.id, mode: "trusted" }] };
  await save(page).click();
  await back(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: "SSH accesses" }),
  ).toBeVisible();
});
