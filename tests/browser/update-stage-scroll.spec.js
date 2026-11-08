import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

// Long release notes push the stage button below the fold on a phone. Staging swaps
// the candidate card for the staged one, whose notes load again; the page must not
// leave the owner at the top with the next step out of sight.
test("staging a release on a phone brings the activate button into view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await operationsFixture(page);
  const body = Array.from({ length: 30 }, (_, i) => `- Change ${i + 1}`).join("\n");
  await page.route("**/api/operations/releases/notes**", (route) => {
    const url = new URL(route.request().url());
    const to = url.searchParams.get("to");
    return route.fulfill({
      json: to
        ? { from: url.searchParams.get("from"), to, releases: [{ version: to, body }] }
        : { version: url.pathname.split("/").at(-1), body },
    });
  });
  await page.goto(baseURL + "/settings/updates");
  await page.getByRole("button", { name: "Nach Updates suchen", exact: true }).click();
  const stage = page.getByRole("button", { name: "Version vorbereiten", exact: true });
  await stage.scrollIntoViewIfNeeded();
  await stage.click();
  await expect(page).toHaveURL(/job=job-stage/);
  const activate = page.getByRole("button", {
    name: "Vorbereitete Version aktivieren: 1.1.0",
    exact: true,
  });
  await expect(activate).toBeInViewport({ ratio: 1 });
  // The notes follow the actions, so their loading does not move the button away.
  await expect(page.getByText("Change 30", { exact: true })).toBeAttached();
  await expect(activate).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: ".cache/update-stage-phone-de.png" });
});
