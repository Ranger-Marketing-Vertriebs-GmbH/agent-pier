import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { packagedServer, versions } from "./mcp-packages-fixture.js";
import { directorySetup, dto } from "./mcp-directory-fixture.js";

const fromDirectory = () =>
  packagedServer("ready", {
    name: "opnsense",
    source: {
      registry: "npm",
      name: "server-x",
      version: "1.0.0",
      status: "ready",
      leadingArgs: 1,
    },
    directoryOrigin: { name: dto.opnsense.name, version: "1.0.0" },
    envNames: ["OPNSENSE_API_KEY", "EXTRA"],
  });

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("a newer directory version shows a pill and pre-fills the update", async ({
      page,
    }) => {
      const state = await directorySetup(page, {
        servers: [fromDirectory()],
        versions,
        directory: { updates: [{ serverId: "s1", version: "1.1.0" }] },
      });
      await page.goto(`${baseURL}/accounts?section=mcp-servers`);
      await expect(
        page.getByRole("link", { name: /^opnsense/ }).getByText("Update available"),
      ).toBeVisible();
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
      const panel = page.locator(".mcp-package");
      await expect(
        panel.getByText("Version 1.1.0 is listed in the directory."),
      ).toBeVisible();
      await expect(panel.locator(".mcp-package-update select")).toHaveValue("1.1.0");
      expect(state.requests.some((r) => r.path === "/api/mcp-directory/updates")).toBe(
        true,
      );
    });

    test("a changed identifier is a hint, never a pre-filled version", async ({
      page,
    }) => {
      await directorySetup(page, {
        servers: [fromDirectory()],
        versions,
        directory: { updates: [{ serverId: "s1", hint: "identifier" }] },
      });
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
      await expect(
        page.getByText(/now lists another package for this server/),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: /^opnsense/ }).getByText("Update available"),
      ).toHaveCount(0);
    });

    test("edit settings marks the directory's required names", async ({ page }) => {
      await directorySetup(page, { servers: [fromDirectory()] });
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1&step=settings`);
      const key = page.locator(".mcp-row", { hasText: "OPNSENSE_API_KEY" });
      await expect(key.getByText("Required")).toBeVisible();
      await expect(
        page.locator(".mcp-row", { hasText: "EXTRA" }).getByText("Required"),
      ).toHaveCount(0);
    });
  });
}
