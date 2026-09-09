import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function fixture(page, target) {
  const files = [];
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    let json = {};
    if (url.pathname === "/api/state")
      json = {
        tools: [{ id: "codex", name: "Codex", installed: true }],
        accounts: [],
        home: "/fixture",
        sessions: [
          {
            id: "links",
            name: "File links",
            tool: "codex",
            cwd: "/fixture/repo",
            status: "running",
          },
        ],
      };
    else if (url.pathname.endsWith("/chat"))
      json = {
        availability: "ready",
        tasks: [],
        messages: [
          {
            id: "answer",
            role: "assistant",
            text: `[Abnahmebericht](<${target}>)\n\n[Website](https://example.com/report)`,
          },
        ],
      };
    else if (url.pathname.endsWith("/files/content")) {
      const file = url.searchParams.get("path");
      files.push(file);
      if (file.startsWith("/"))
        return route.fulfill({
          status: 403,
          json: { error: "Datei liegt außerhalb des Projektordners." },
        });
      json = { type: "text", text: "# Acceptance report\nVerified results", path: file };
    } else if (url.pathname.endsWith("/files"))
      json = { entries: [], total: 0, page: 1, hasMore: false };
    return route.fulfill({ json });
  });
  await page.goto(baseURL + "/sessions/links/chat");
  return files;
}

for (const target of [
  "docs/report.md",
  "/fixture/repo/docs/report.md:12",
  "file:///fixture/repo/docs/report.md#L12",
  "docs/report%20final.md",
]) {
  test(`local chat link opens the project preview: ${target}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const files = await fixture(page, target);
    await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
    await expect(page.getByLabel("Dateivorschau")).toContainText("Verified results");
    expect(files[0]).toBe(
      target.includes("final") ? "docs/report final.md" : "docs/report.md",
    );
    expect(page.context().pages()).toHaveLength(1);
    if (target === "docs/report.md")
      await page.screenshot({ path: ".cache/chat-file-preview-mobile.png" });
    await page.goBack();
    await expect(
      page.getByRole("link", { name: "Abnahmebericht", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Website", exact: true }),
    ).toHaveAttribute("href", "https://example.com/report");
  });
}

test("outside-project links show the bounded file error inside the app", async ({
  page,
}) => {
  await fixture(page, "/outside/report.md");
  await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("außerhalb des Projektordners");
  await expect(page.locator("body")).not.toContainText("npm run build");
});
