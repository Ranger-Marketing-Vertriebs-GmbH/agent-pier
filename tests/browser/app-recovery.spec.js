import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

test("failed startup module leaves a visible way to reopen the app", async ({ page }) => {
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto(baseURL);
  await expect(page.getByRole("link", { name: "Erneut öffnen" })).toBeVisible();
});

test("a failed lazy module shows recovery instead of removing the whole interface", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        tools: [],
        accounts: [],
        home: "/fixture",
        sessions: [
          {
            id: "recovery",
            name: "Recovery",
            tool: "codex",
            cwd: "/fixture",
            status: "running",
          },
        ],
        messages: [],
        tasks: [],
        availability: "ready",
      },
    }),
  );
  await page.route("**/assets/TerminalView-*.js", (route) => route.abort());
  await page.goto(baseURL + "/sessions/recovery/chat");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ansicht neu laden" })).toBeVisible();
});
