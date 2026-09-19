import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
for (const language of ["en", "de"])
  test(`artifact management opens privately, pins and deletes (${language})`, async ({
    page,
    context,
  }) => {
    const labels =
      language === "en"
        ? {
            open: "Open Report",
            pin: "Pin",
            unpin: "Unpin",
            remove: "Delete",
            dialog: "Delete artifact?",
            empty: "No artifacts yet.",
          }
        : {
            open: "Report öffnen",
            pin: "Anpinnen",
            unpin: "Lösen",
            remove: "Löschen",
            dialog: "Artifact löschen?",
            empty: "Noch keine Artifacts.",
          };
    await page.addInitScript(
      (value) => localStorage.setItem("agentpier-language", value),
      language,
    );
    let items = [
      {
        id: "example",
        title: "Report",
        sessionId: "session-one",
        projectId: "project-one",
        pinned: false,
        orphaned: false,
        sizeBytes: 42,
        mediaType: "text/html",
        updatedAt: "2026-09-19T12:00:00.000Z",
      },
    ];
    await context.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      let result = {};
      if (url.pathname === "/api/state")
        result = { tools: [], accounts: [], sessions: [], home: "/tmp", remoteUrl: null };
      else if (url.pathname === "/api/memory/projects")
        result = { projects: [{ id: "project-one", name: "Example" }] };
      else if (url.pathname === "/api/artifacts")
        result = { items, total: items.length, page: 1 };
      else if (url.pathname.endsWith("/usage"))
        result = { usedBytes: 42, pendingCleanupBytes: 0, limitBytes: 1073741824 };
      else if (url.pathname.endsWith("/bundle"))
        result = {
          artifact: items[0],
          entrypoint: "index.html",
          files: [
            {
              path: "index.html",
              mediaType: "text/html",
              base64: Buffer.from("<h1>Private report</h1>").toString("base64"),
            },
          ],
        };
      else if (route.request().method() === "PATCH") {
        items[0].pinned = route.request().postDataJSON().pinned;
        result = items[0];
      } else if (route.request().method() === "DELETE") items = [];
      await route.fulfill({ json: result });
    });
    await page.goto(`${base}/artifacts/project-one`);
    await expect(page.getByRole("link", { name: labels.open })).toBeVisible();
    if (process.env.CAPTURE_ARTIFACT_SCREENSHOTS && language === "en") {
      await page.screenshot({
        path: "docs/screenshots/artifacts-desktop.png",
        animations: "disabled",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(async () =>
          page.locator(".sidebar").evaluate((node) => node.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
      await expect(page.getByRole("link", { name: labels.open })).toBeInViewport();
      await page.screenshot({
        path: "docs/screenshots/artifacts-mobile.png",
        animations: "disabled",
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    const popup = page.waitForEvent("popup");
    await page.getByRole("link", { name: labels.open }).click();
    const viewer = await popup;
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Private report" }),
    ).toBeVisible();
    await viewer.close();
    await page.getByRole("button", { name: labels.pin, exact: true }).click();
    await expect(
      page.getByRole("button", { name: labels.unpin, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: labels.remove, exact: true }).click();
    await page
      .getByRole("dialog", { name: labels.dialog })
      .getByRole("button", { name: labels.remove, exact: true })
      .click();
    await expect(page.getByText(labels.empty)).toBeVisible();
  });
