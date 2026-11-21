import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { craftRebuildsFixture, rebuild, waitingId } from "./craft-rebuilds-fixture.js";

// What a rebuild's page says about Craft Anything 0.6.0's own reports: a paused build's
// note, several checks per round, unpriced usage, a question answered elsewhere, auto
// mode with questions already waiting, and the account of a session opened there.

const pausedId = "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918";
const paused = () =>
  rebuild({
    id: pausedId,
    projectId: "counter",
    folder: "/fixture/projects/counter",
    name: "counter",
    request: "A counter page.",
    // Not the managed account a fresh dialog would prefer.
    accountId: "local-claude",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "paused",
    step: "check",
    note: "Paused. Send a message to continue.",
    checks: [
      { round: 1, check: "build", passed: true },
      { round: 1, check: "app-screenshot", passed: false },
    ],
    usage: { inputTokens: 117140, outputTokens: 1217, costUsd: null },
  });

test("a paused rebuild says Continue resumes it, counts its checks and has no price", async ({
  page,
}) => {
  await craftRebuildsFixture(page, { rebuilds: [paused()] });
  await page.goto(`${baseURL}/craft/${pausedId}`);
  await expect(
    page.getByText("Paused. Continue picks the build up where it stopped."),
  ).toBeVisible();
  // The activity still quotes Craft Anything; the summary no longer does.
  await expect(page.locator(".craft-summary")).not.toContainText("Send a message");
  await expect(page.getByText("1 of 2 checks pass")).toBeVisible();
  await expect(page.getByText("No price known")).toBeVisible();
  await expect(page.getByText("About $0.00")).toHaveCount(0);
});

test("Open a session here starts with the rebuild's Claude account", async ({ page }) => {
  await craftRebuildsFixture(page, { rebuilds: [paused()] });
  // The new-session dialog's own lists, empty.
  await page.route("**/api/ssh-accesses", (route) =>
    route.fulfill({ json: { accesses: [] } }),
  );
  await page.route("**/api/secrets", (route) => route.fulfill({ json: { secrets: [] } }));
  await page.goto(`${baseURL}/craft/${pausedId}`);
  await page.getByRole("button", { name: "Open a session here" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Connection", { exact: true })).toHaveValue(
    "local-claude",
  );
});

test("a question answered elsewhere says so; auto mode names the questions still waiting", async ({
  page,
}) => {
  await craftRebuildsFixture(page);
  await page.route(`**/api/craft/rebuilds/${waitingId}/answer`, (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: "This question is no longer open.",
        messageKey: "craft.rebuildQuestionGone",
      },
    }),
  );
  await page.goto(`${baseURL}/craft/${waitingId}`);
  await page
    .getByRole("group", { name: "Answers" })
    .getByRole("button", { name: "Dark blue" })
    .click();
  await expect(
    page.getByText("This question was already answered elsewhere"),
  ).toBeVisible();
  await page.getByRole("switch", { name: "Auto mode" }).check();
  await expect(page.getByText("Auto mode decides new questions.")).toBeVisible();
});
