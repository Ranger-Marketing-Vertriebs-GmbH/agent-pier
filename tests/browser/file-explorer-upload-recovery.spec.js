import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { baseURL } from "../helpers/browser.js";
import { selectEnglish } from "../helpers/file-explorer-browser.js";
import { uploadsFixture } from "../helpers/file-uploads-browser.js";

const source = (name, text = name) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(text),
});
async function observeXHR(page) {
  await page.addInitScript(() => {
    window.uploadRequests = [];
    window.loginRequiredEvents = 0;
    window.addEventListener(
      "agentpier-login-required",
      () => window.loginRequiredEvents++,
    );
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (...args) {
      if (args[0] === "PUT") {
        const record = { url: args[1], xhr: this, aborted: false };
        this.addEventListener("abort", () => {
          record.aborted = true;
        });
        window.uploadRequests.push(record);
      }
      return open.apply(this, args);
    };
  });
}

test("native folder fallback retains relative paths, discloses empty omissions and persists no contents", async ({
  page,
}) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentpier-upload-selection-"),
  );
  const root = path.join(directory, "root");
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  await fs.mkdir(path.join(root, "empty"));
  const marker = "private-upload-content-do-not-persist-938413";
  await fs.writeFile(path.join(root, "nested", "same.txt"), marker);
  const { state: f } = await uploadsFixture(page);
  try {
    await selectEnglish(page);
    await page.goto(baseURL + "/files");
    const databases = await page.evaluate(async () =>
      (await indexedDB.databases()).map(({ name }) => name),
    );
    await page.getByLabel("Upload folder", { exact: true }).setInputFiles(root);
    const uploads = page.getByRole("region", { name: "Uploads", exact: true });
    await expect(uploads).toContainText("Upload completed");
    await expect(uploads).toContainText(
      "This browser selection cannot include empty folders.",
    );
    expect(f.raw).toHaveLength(1);
    expect(f.raw[0].declaration.bytes).toBe(Buffer.byteLength(marker));
    expect([...f.groups.values()][0].entries.size).toBe(3);
    await expect(uploads).toContainText("root/nested/same.txt");
    const storage = await page.evaluate(async () => ({
      text: JSON.stringify({ ...localStorage, ...sessionStorage }),
      databases: (await indexedDB.databases()).map(({ name }) => name),
    }));
    expect(storage.text).not.toContain(marker);
    expect(storage.text).not.toContain(Buffer.from(marker).toString("base64"));
    expect(storage.databases).toEqual(databases);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("100 percent transport progress waits for durable completion and true cancellation aborts its XHR", async ({
  page,
}) => {
  const { state: f } = await uploadsFixture(page);
  await observeXHR(page);
  f.hold = true;
  try {
    await selectEnglish(page);
    await page.goto(baseURL + "/files");
    await page
      .getByLabel("Upload files", { exact: true })
      .setInputFiles(source("cancel.txt"));
    await expect.poll(() => f.raw.length).toBe(1);
    await page.evaluate(() =>
      window.uploadRequests[0].xhr.upload.dispatchEvent(
        new ProgressEvent("progress", { loaded: 10, total: 10, lengthComputable: true }),
      ),
    );
    const uploads = page.getByRole("region", { name: "Uploads", exact: true });
    await expect(uploads.getByRole("progressbar")).toHaveAttribute("value", "10");
    await expect(uploads).not.toContainText("Upload completed");
    await page.getByRole("button", { name: "Cancel cancel.txt", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.uploadRequests[0].aborted))
      .toBe(true);
    await expect.poll(() => f.jobs.get(f.raw[0].id).status).toBe("cancelled");
    expect(
      f.requests.filter((request) => request.suffix === `/jobs/${f.raw[0].id}/cancel`),
    ).toHaveLength(1);
    expect(f.raw).toHaveLength(1);
    f.release();
    await page.getByRole("button", { name: "Retry cancel.txt", exact: true }).click();
    await expect(uploads).toContainText("Upload completed");
    expect(f.raw).toHaveLength(2);
    expect(f.raw[0].id).not.toBe(f.raw[1].id);
  } finally {
    f.release();
  }
});

test("reload requires explicit source reselection and only unfinished files receive new attempts", async ({
  page,
}) => {
  const { state: f } = await uploadsFixture(page);
  f.failures.add("failed.txt");
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const files = [source("done.txt"), source("failed.txt")];
  await page.getByLabel("Upload files", { exact: true }).setInputFiles(files);
  await expect(
    page.getByRole("button", { name: "Retry failed.txt", exact: true }),
  ).toBeEnabled();
  const group = [...f.groups.values()][0];
  await page.reload();
  await page.getByText("Recover an upload", { exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`Upload ${group.job.id}`) }).click();
  const uploads = page.getByRole("region", { name: "Uploads", exact: true });
  await expect(uploads).toContainText("Local source files are no longer available.");
  expect(f.raw).toHaveLength(2);
  expect(f.attempts.size).toBe(2);
  await page.getByLabel("Reselect files", { exact: true }).setInputFiles(files);
  await expect(uploads).toContainText("Upload completed");
  expect(f.raw.filter((item) => item.declaration.name === "done.txt")).toHaveLength(1);
  expect(f.raw.filter((item) => item.declaration.name === "failed.txt")).toHaveLength(2);
});

test("login expiry dispatches the existing event and does not duplicate uncertain bytes", async ({
  page,
}) => {
  const { state: f } = await uploadsFixture(page);
  await observeXHR(page);
  f.lose.add("auth");
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page
    .getByLabel("Upload files", { exact: true })
    .setInputFiles(source("auth.txt"));
  await expect.poll(() => page.evaluate(() => window.loginRequiredEvents)).toBe(1);
  expect(f.raw).toHaveLength(1);
  expect(f.attempts.size).toBe(1);
  expect(f.jobs.get(f.raw[0].id).status).toBe("running");
  expect(f.requests.filter((item) => item.suffix === "/uploads")).toHaveLength(1);
});

test("pruned failed rows accept explicit reselection while null pending and published rows send no bytes", async ({
  page,
}) => {
  const { state: f } = await uploadsFixture(page);
  const group = f.seed(
    ["failed", "running", "published", "completed"].map((status) => ({
      id: status,
      relativePath: `${status}.txt`,
      path: `/home/test/${status}.txt`,
      type: "file",
      bytes: 1,
      status,
      outputPublished: status === "published" || status === "completed",
    })),
    { status: "partially_completed" },
  );
  for (const row of group.entries.values()) group.children.set(row.id, null);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByText("Recover an upload", { exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`Upload ${group.job.id}`) }).click();
  const uploads = page.getByRole("region", { name: "Uploads", exact: true });
  await expect(uploads).toContainText("Current attempt details are unavailable.");
  expect(f.raw).toHaveLength(0);
  await page
    .getByLabel("Reselect files", { exact: true })
    .setInputFiles(
      ["failed", "running", "published", "completed"].map((name) =>
        source(`${name}.txt`, "x"),
      ),
    );
  await expect(
    page
      .locator(".file-upload-rows li")
      .filter({ hasText: "failed.txt" })
      .getByRole("status"),
  ).toHaveText("Completed");
  expect(f.raw).toHaveLength(1);
  expect(f.raw[0].declaration.entryId).toBe("failed");
  expect(f.attempts.size).toBe(1);
  expect(f.raw[0].body).toEqual(Buffer.from("x"));
});

test("leaving the upload scope aborts the old XHR and returning does not restore File consent", async ({
  page,
}) => {
  const { state: f } = await uploadsFixture(page);
  await observeXHR(page);
  f.hold = true;
  try {
    await selectEnglish(page);
    await page.goto(baseURL + "/files");
    await page
      .getByLabel("Upload files", { exact: true })
      .setInputFiles(source("scope.txt"));
    await expect.poll(() => f.raw.length).toBe(1);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.uploadRequests[0].aborted))
      .toBe(true);
    f.failures.add("scope.txt");
    f.release();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page.getByText("Recover an upload", { exact: true }).click();
    const group = [...f.groups.values()][0];
    await page
      .getByRole("button", { name: new RegExp(`Upload ${group.job.id}`) })
      .click();
    await expect(page.getByLabel("Reselect files", { exact: true })).toBeAttached();
    expect(f.raw).toHaveLength(1);
  } finally {
    f.release();
  }
});

test("upload recovery renders inspected English desktop and German 390px evidence", async ({
  page,
  browserName,
}) => {
  const { state: f } = await uploadsFixture(page);
  f.failures.add("retry-me.txt");
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page
    .getByLabel("Upload files", { exact: true })
    .setInputFiles([source("completed.txt"), source("retry-me.txt")]);
  await expect(
    page.getByRole("button", { name: "Retry retry-me.txt", exact: true }),
  ).toBeEnabled();
  await expect(
    page
      .locator(".file-upload-rows li")
      .filter({ hasText: "completed.txt" })
      .getByRole("status"),
  ).toHaveText("Completed");
  await page.screenshot({
    path: `.cache/task14-${browserName}-en-desktop.png`,
    fullPage: true,
  });
  await page.goto(baseURL + "/settings");
  await page.getByLabel("Language", { exact: true }).selectOption("de");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/files");
  await page.getByText("Upload wiederherstellen", { exact: true }).click();
  await page
    .getByRole("button", {
      name: new RegExp(`Upload ${[...f.groups.values()][0].job.id}`),
    })
    .click();
  await expect(
    page.getByLabel("Dateien erneut auswählen", { exact: true }),
  ).toBeAttached();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({
    path: `.cache/task14-${browserName}-de-390.png`,
    fullPage: true,
  });
});
