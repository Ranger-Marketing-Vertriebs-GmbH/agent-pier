import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

test.use({ isMobile: true, hasTouch: true });

const snapshot = {
  artifact: { id: "example", title: "A very long report title ".repeat(8) },
  entrypoint: "index.html",
  files: [
    {
      path: "index.html",
      mediaType: "text/html",
      base64: Buffer.from(
        '<h1>Private report</h1><div style="height:4000px"></div><p>End</p>',
      ).toString("base64"),
    },
  ],
};

async function fixture(
  page,
  language,
  respond = (route) => route.fulfill({ json: snapshot }),
) {
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/artifacts/example/bundle") return respond(route);
    const json =
      pathname === "/api/state"
        ? { tools: [], accounts: [], sessions: [], home: "/fixture" }
        : pathname === "/api/artifacts"
          ? { items: [], total: 0, page: 1 }
          : pathname === "/api/artifacts/usage"
            ? { usedBytes: 0, pendingCleanupBytes: 0, limitBytes: 1024 }
            : pathname === "/api/memory/projects"
              ? { projects: [] }
              : {};
    return route.fulfill({ json });
  });
  await page.goto(`${baseURL}/artifacts/view/example`);
}

async function leaveViewer(page, label, heading) {
  const exit = page.getByRole("link", { name: label, exact: true });
  await expect(exit).toBeInViewport();
  const box = await exit.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  await exit.tap();
  await expect(page).toHaveURL(`${baseURL}/artifacts`);
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
}

for (const language of ["en", "de"])
  test(`mobile artifact can return to AgentPier without browser controls (${language})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: language === "en" ? 390 : 320, height: 568 });
    await fixture(page, language);
    const frame = page.frameLocator("iframe");
    await expect(frame.getByRole("heading", { name: "Private report" })).toBeVisible();
    await frame.getByText("End", { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
    if (process.env.CAPTURE_ARTIFACT_SCREENSHOTS && language === "en")
      await page.screenshot({ path: "docs/screenshots/artifact-viewer-mobile.png" });
    await leaveViewer(
      page,
      language === "en" ? "Back to AgentPier" : "Zurück zu AgentPier",
      "Artifacts",
    );
  });

test("mobile artifact can exit while its bundle is still loading", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const release = Promise.withResolvers();
  try {
    await fixture(page, "en", async (route) => {
      await release.promise;
      await route.abort().catch(() => {});
    });
    await expect(page.getByRole("status")).toHaveText("Loading artifact…");
    await leaveViewer(page, "Back to AgentPier", "Artifacts");
  } finally {
    release.resolve();
  }
});

for (const failure of ["unavailable", "unsupported"])
  test(`mobile artifact can exit after an ${failure} bundle`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, "en", (route) =>
      failure === "unavailable"
        ? route.fulfill({ status: 404, json: { error: "Not found" } })
        : route.fulfill({
            json: {
              ...snapshot,
              files: [],
            },
          }),
    );
    await expect(page.getByRole("alert")).toBeVisible();
    await leaveViewer(page, "Back to AgentPier", "Artifacts");
  });
