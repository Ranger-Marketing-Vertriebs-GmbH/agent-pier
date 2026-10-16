import { test, expect } from "@playwright/test";
import path from "node:path";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

test.use({ locale: "en-GB" });
const screenshots = process.env.AGENTPIER_SCREENSHOTS;

test("a restore archive uploads in slices, shows progress and resumes a failed slice", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  // Slices of 1 MiB, so the 3 MiB archive needs three.
  state.uploadChunkLimit = 1024 * 1024;
  state.failOnce = { path: "/operations/restore/uploads/upload-one", method: "PUT" };
  state.hold = "/operations/restore/uploads/upload-one/complete";
  await page.goto(baseURL + "/settings/backups");
  await page
    .getByRole("button", { name: "Inspect and restore backup", exact: true })
    .click();
  await page.getByLabel("Backup file", { exact: true }).setInputFiles({
    name: "fixture.apbackup",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(3 * 1024 * 1024, 1),
  });
  await page.getByRole("button", { name: "Inspect archive", exact: true }).click();
  const status = page.getByRole("dialog").getByRole("status");
  await expect(status).toContainText("Uploading backup file: 100%");
  await expect(status.locator("progress")).toHaveAttribute(
    "max",
    String(3 * 1024 * 1024),
  );
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    if (screenshots) {
      // The dialog settles into its layout for this width first.
      await page.waitForTimeout(400);
      await page.screenshot({
        path: path.join(screenshots, `restore-upload-${viewport.name}.png`),
      });
    }
  }
  state.release();
  await expect(page.getByLabel("New data directory", { exact: true })).toBeVisible();
  await expect(status).toHaveCount(0);
  // The failed first slice was sent again at the server's offset, then the rest.
  expect(state.uploadSlices).toEqual([0, 1048576, 2097152]);
  expect(
    state.calls.filter(
      (call) =>
        call.path === "/operations/restore/uploads/upload-one" && call.method === "GET",
    ),
  ).toHaveLength(1);
  expect(
    state.calls.find((call) => call.path === "/operations/restore/uploads").body,
  ).toEqual({ size: 3 * 1024 * 1024 });
});

/** Answers the next `method` request to `path` with the server's "not found". */
async function goneOnce(page, path, method) {
  let pending = true;
  await page.route(`**/api${path}`, (route) => {
    if (!pending || route.request().method() !== method) return route.fallback();
    pending = false;
    return route.fulfill({ status: 404, json: { error: "Uploaded archive not found." } });
  });
}
async function chooseArchive(page) {
  await page.goto(baseURL + "/settings/backups");
  await page
    .getByRole("button", { name: "Inspect and restore backup", exact: true })
    .click();
  await page.getByLabel("Backup file", { exact: true }).setInputFiles({
    name: "fixture.apbackup",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(1024, 1),
  });
  return page.getByRole("button", { name: "Inspect archive", exact: true });
}
const uploadStarts = (state) =>
  state.calls.filter(
    (call) => call.path === "/operations/restore/uploads" && call.method === "POST",
  );

test("an upload the server no longer has starts anew on the next attempt", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  state.failOnce = { path: "/operations/restore/uploads/upload-one", method: "PUT" };
  // The server lost the upload (expired, or removed) while a slice was resent.
  await goneOnce(page, "/operations/restore/uploads/upload-one", "GET");
  const inspect = await chooseArchive(page);
  await inspect.click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await inspect.click();
  await expect(page.getByLabel("New data directory", { exact: true })).toBeVisible();
  expect(uploadStarts(state)).toHaveLength(2);
});

test("an uploaded archive the server removed is uploaded again for its inspection", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  state.failOnce = { path: "/operations/restore/inspect", method: "POST" };
  const inspect = await chooseArchive(page);
  await inspect.click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  // Before the next attempt, the uploaded archive expired.
  await goneOnce(page, "/operations/restore/inspect", "POST");
  await inspect.click();
  await expect(page.getByLabel("New data directory", { exact: true })).toBeVisible();
  expect(uploadStarts(state)).toHaveLength(2);
});
