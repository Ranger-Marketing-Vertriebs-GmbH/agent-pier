import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";
import { baseURL } from "../helpers/browser.js";

test.use({ locale: "en-GB" });

const report = {
  version: "0.0.0-test",
  generatedAt: "2026-10-17T10:00:00.000Z",
  checks: [
    // An older server may still send a remedy on a passing check.
    {
      id: "platform",
      status: "ok",
      summary: "darwin/arm64",
      remedy: "Use a supported macOS or Linux host.",
    },
    {
      id: "tmux",
      status: "fail",
      summary: "Executable is unavailable.",
      remedy: "Untranslated server text.",
      remedyId: "tool",
    },
  ],
};

test("only failing checks show their translated remedy as text", async ({ page }) => {
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
  const passing = card("Operating system");
  await expect(passing.locator("header")).toContainText("OK");
  await expect(passing.getByText("Suggested fix")).toHaveCount(0);
  await expect(passing.getByText("Use a supported macOS or Linux host.")).toHaveCount(0);
  const failing = card("tmux");
  await expect(failing.locator("header")).toContainText("Failed");
  await expect(failing.getByText("Suggested fix")).toBeVisible();
  const remedy = failing.getByText("Install the tool or correct the service PATH.", {
    exact: true,
  });
  await expect(remedy).toBeVisible();
  await expect(remedy).toHaveJSProperty("tagName", "P");
  await expect(failing.getByText("Untranslated server text.")).toHaveCount(0);
  await expect(failing.locator("pre")).toHaveCount(0);
});
