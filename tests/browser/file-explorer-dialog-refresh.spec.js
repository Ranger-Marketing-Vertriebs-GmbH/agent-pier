import { test, expect } from "@playwright/test";
import { actionsFixture } from "../helpers/file-actions-browser.js";
import { explorerContext, selectEnglish } from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";

for (const outcome of [
  "unchanged",
  "rename",
  "revised",
  "removed",
  "failed",
  "navigation",
  "sorting",
  "cancelled",
])
  test(`background listing refresh keeps confirmation paused until ${outcome} ownership is known`, async ({
    page,
  }, testInfo) => {
    const f = await actionsFixture(page);
    const release = Promise.withResolvers();
    let hold = false,
      reads = 0;
    await page.route("**/api/files/entries?**", async (route) => {
      const url = new URL(route.request().url());
      if (hold && url.searchParams.get("path") === "/home/test") {
        reads++;
        await release.promise;
        if (outcome === "failed")
          return route.fulfill({ status: 503, json: { code: "FILE_IO_ERROR" } });
      }
      return route.fallback();
    });
    try {
      await selectEnglish(page);
      await page.goto(baseURL + "/files");
      await page.getByRole("checkbox", { name: "Select a.txt", exact: true }).check();
      const title = outcome === "rename" ? "Rename" : "Move to Trash";
      await page.getByRole("button", { name: title, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await expect(dialog).toBeVisible();
      if (outcome === "rename")
        await dialog.getByLabel("Name", { exact: true }).fill("renamed.txt");
      hold = true;
      f.jobs.set("background", {
        id: "background",
        scopeId: explorerContext.scopeId,
        kind: "create_file",
        status: "completed",
        completedEntries: 1,
        conflict: null,
      });
      await expect.poll(() => reads).toBeGreaterThan(0);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("/home/test/a.txt");
      const confirm = dialog.getByRole("button", { name: "Confirm", exact: true });
      await expect(confirm).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeEnabled();
      if (outcome === "unchanged")
        await page.screenshot({
          path: testInfo.outputPath("paused-confirmation-en.png"),
        });
      // Programmatic form submission must also respect pending revalidation.
      await dialog.locator("form").evaluate((form) => form.requestSubmit());
      expect(
        f.requests.filter((request) => request.suffix === "/operations"),
      ).toHaveLength(0);
      if (outcome === "revised")
        f.files = f.files.map((item) =>
          item.name === "a.txt" ? { ...item, revision: `e1:${"b".repeat(64)}` } : item,
        );
      if (outcome === "removed")
        f.files = f.files.filter((item) => item.name !== "a.txt");
      if (outcome === "navigation") {
        await page.evaluate(() => {
          history.pushState({}, "", "/files?path=%2Fhome%2Ftest%2Fdocs");
          dispatchEvent(new PopStateEvent("popstate"));
        });
        await expect(dialog).toHaveCount(0);
      }
      if (outcome === "sorting") {
        await page.evaluate(() => {
          history.pushState({}, "", "/files?sort=size");
          dispatchEvent(new PopStateEvent("popstate"));
        });
        await expect(dialog).toHaveCount(0);
      }
      if (outcome === "cancelled") {
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).toHaveCount(0);
      }
      hold = false;
      release.resolve();
      if (["unchanged", "rename"].includes(outcome)) {
        await expect(confirm).toBeEnabled();
        await expect(
          page.getByRole("checkbox", { name: "Select a.txt", exact: true }),
        ).toBeChecked();
        await confirm.click();
        await expect
          .poll(
            () => f.requests.filter((request) => request.suffix === "/operations").length,
          )
          .toBe(1);
        const body = f.requests.find((request) => request.suffix === "/operations").body;
        expect(body.kind).toBe(outcome === "rename" ? "rename" : "trash");
        if (outcome === "rename") expect(body.name).toBe("renamed.txt");
        expect(body.sources).toEqual(["/home/test/a.txt"]);
      } else {
        await expect(dialog).toHaveCount(0);
        expect(
          f.requests.filter((request) => request.suffix === "/operations"),
        ).toHaveLength(0);
      }
    } finally {
      release.resolve();
    }
  });
