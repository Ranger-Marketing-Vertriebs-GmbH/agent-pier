import { test, expect } from "@playwright/test";
import { fixture } from "./ssh-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(locale, () => {
    test.use({ locale });
    for (const width of [1280, 390]) {
      test(`session layout, extensions and directory navigation at ${width}px`, async ({
        page,
      }) => {
        const en = locale === "en-GB";
        await page.setViewportSize({ width, height: 844 });
        await fixture(page);
        await page.route("**/api/pipeline-profiles", (route) =>
          route.fulfill({ json: { profiles: [] } }),
        );
        await page.route("**/api/directories?**", (route) =>
          route.fulfill({
            json: { path: "/fixture/project", parent: null, entries: [] },
          }),
        );
        const launches = [];
        await page.route("**/api/sessions", (route) => {
          launches.push(route.request().postDataJSON());
          return route.fulfill({
            status: 409,
            json: { error: "Fixture launch rejected" },
          });
        });
        await page.goto("/");
        await (width < 700 ? page.getByRole("main") : page)
          .getByRole("button", { name: en ? "New session" : "Neue Sitzung", exact: true })
          .click();
        const dialog = page.getByRole("dialog");
        const start = dialog.getByRole("button", {
          name: en ? "Start session" : "Sitzung starten",
          exact: true,
        });
        const summary = dialog.locator(".launch-extensions > summary");
        await expect(summary).toContainText(en ? "AgentBus on" : "AgentBus aktiv");
        await expect(dialog.getByRole("checkbox", { name: /AgentBus/ })).toHaveCount(0);
        const sections = dialog.locator(".launch-section");
        const left = await sections.nth(0).boundingBox();
        const right = await sections.nth(1).boundingBox();
        if (width > 700) {
          expect(right.x).toBeGreaterThan(left.x + left.width);
          expect(right.y).toBe(left.y);
          expect((await dialog.boundingBox()).width).toBe(900);
        } else {
          expect(right.y).toBeGreaterThan(left.y + left.height);
          expect((await dialog.boundingBox()).width).toBe(width);
        }
        if (en)
          await page.screenshot({ path: test.info().outputPath(`launch-${width}.png`) });
        await expect(start).toBeInViewport();
        await dialog
          .getByLabel(en ? "Session name" : "Name der Sitzung", { exact: true })
          .fill("Layout test");
        await dialog
          .getByRole("button", {
            name: en ? "Choose directory" : "Ordner auswählen",
            exact: true,
          })
          .click();
        await dialog
          .getByRole("button", {
            name: en ? "Use this directory" : "Diesen Ordner verwenden",
            exact: true,
          })
          .click();
        await expect(
          dialog.getByLabel(en ? "Session name" : "Name der Sitzung", { exact: true }),
        ).toHaveValue("Layout test");
        await summary.focus();
        await page.keyboard.press("Enter");
        const bus = dialog.getByRole("checkbox", { name: /AgentBus/ });
        await bus.uncheck();
        await summary.click();
        await expect(summary).toContainText(en ? "AgentBus off" : "AgentBus aus");
        if (width < 700) {
          // A reduced viewport models the space available above a mobile keyboard.
          await page.setViewportSize({ width, height: 430 });
          await expect(start).toBeInViewport();
          await dialog
            .getByLabel(en ? "Session name" : "Name der Sitzung", { exact: true })
            .fill("Keyboard test");
          await expect(start).toBeInViewport();
        }
        await start.click();
        await expect(dialog.getByRole("alert")).toContainText("Fixture launch rejected");
        await expect(dialog.getByRole("alert")).toBeInViewport();
        expect(launches[0]).toMatchObject({
          cwd: "/fixture/project",
          agentbus: false,
          agentpierTools: true,
        });
        await expect(summary).toContainText(en ? "AgentBus off" : "AgentBus aus");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
        await page.setViewportSize({ width, height: 844 });
        await dialog.locator(".form-content").evaluate((el) => {
          el.scrollTop = 0;
        });
      });
    }
  });
}
