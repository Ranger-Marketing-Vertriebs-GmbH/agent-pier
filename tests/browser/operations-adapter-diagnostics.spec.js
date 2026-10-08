import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";
import { baseURL } from "../helpers/browser.js";

test.use({ locale: "en-GB" });

const report = {
  version: "0.0.0-test",
  generatedAt: "2026-10-08T10:00:00.000Z",
  checks: [
    {
      id: "adapter-session.s1",
      status: "fail",
      summary:
        '"Nightly": Codex via adapter (chatCompletions): the protocol adapter stopped after 3 restart(s) (exited) at 2026-10-08T09:59:00.000Z; every request of the CLI now gets HTTP 503.',
      remedy: "Reload the session to restart the protocol adapter.",
      details: {
        restarts: 3,
        supervisor: {
          restarts: 3,
          lastReason: "exited",
          gaveUpAt: "2026-10-08T09:59:00.000Z",
        },
      },
    },
    {
      id: "adapter-session.s2",
      status: "warn",
      summary:
        '"Refactor": Claude Code via adapter (responses): 12 request(s), 1 error(s), 0 restart(s), 0 capability fallback(s), 0 estimated usage report(s), 0 compaction item(s) dropped.',
      details: { requests: { "/v1/messages": 12 }, errors: { rateLimit: 1 } },
    },
  ],
};

test("adapter session checks show label, status, remedy and collapsed details", async ({
  page,
}) => {
  await operationsFixture(page);
  await page.route("**/api/operations/doctor", (route) =>
    route.fulfill({
      json: { report: route.request().method() === "GET" ? null : report },
    }),
  );
  await page.goto(baseURL + "/settings/diagnostics");
  await page.getByRole("button", { name: "Run checks", exact: true }).click();
  const card = (label) =>
    page.locator("article.operations-card").filter({
      has: page.getByText(label, { exact: true }),
    });
  const failed = card("Adapter session: s1");
  await expect(failed.locator("header")).toContainText("Failed");
  await expect(
    failed.getByText("Reload the session to restart the protocol adapter.", {
      exact: true,
    }),
  ).toBeVisible();
  const details = failed.locator("details");
  await expect(details.locator("pre")).toBeHidden();
  await details.locator("summary").click();
  await expect(details.locator("pre")).toContainText('"gaveUpAt"');
  await expect(card("Adapter session: s2").locator("header")).toContainText("Notice");
  if (process.env.CAPTURE_ADAPTER_SCREENSHOTS) {
    await page.screenshot({
      path: "docs/screenshots/diagnostics-adapter-session.png",
      animations: "disabled",
    });
  }
});
