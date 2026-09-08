import { test, expect } from "@playwright/test";
import { fixture, openRepositories } from "../helpers/repository-browser.js";

for (const mobile of [false, true]) {
  test(`searchable clone organization and repository dropdowns (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page);
    const searches = [];
    await page.route("**/api/repositories/discover?*", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      searches.push(Object.fromEntries(params));
      await route.fulfill({
        json: {
          organizations: Array.from({ length: 180 }, (_, i) => ({ login: `team-${i}` })),
          repositories:
            params.get("q") === "pier"
              ? [
                  {
                    id: "pier",
                    name: "agent-pier",
                    fullName: "team-179/agent-pier",
                    url: "https://github.com/team-179/agent-pier.git",
                    private: true,
                  },
                ]
              : [],
          total: 1,
          hasMore: false,
        },
      });
    });
    await openRepositories(page);
    await page.getByLabel("Token-Profil").selectOption("personal");
    await page.getByRole("button", { name: "Organisation", exact: true }).click();
    await page.getByRole("combobox", { name: "Organisation suchen" }).fill("team-179");
    await expect(page.getByRole("option", { name: "team-178", exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("option", { name: "team-179", exact: true }),
    ).toBeVisible();
    if (mobile)
      await page.screenshot({
        path: "/tmp/agentpier-repository-search-mobile.png",
        animations: "disabled",
      });
    await page.getByRole("option", { name: "team-179", exact: true }).click();
    await page
      .getByRole("button", { name: "Verfügbare Repositories", exact: true })
      .click();
    const search = page.getByRole("combobox", { name: "Repository suchen" });
    await search.fill("pier");
    await expect(
      page.getByRole("option", { name: /team-179\/agent-pier/ }),
    ).toBeVisible();
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(page.getByLabel("Repository-URL oder owner/repo")).toHaveValue(
      "https://github.com/team-179/agent-pier.git",
    );
    await expect(page.getByLabel("Neuer Ordnername")).toHaveValue("agent-pier");
    expect(
      searches.some(
        (request) => request.organization === "team-179" && request.q === "pier",
      ),
    ).toBe(true);
    await expect(page.getByRole("listbox")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });
}
