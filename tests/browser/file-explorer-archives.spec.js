import { test, expect } from "@playwright/test";
import { actionsFixture } from "../helpers/file-actions-browser.js";
import { selectEnglish } from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";
import {
  jobsFixture,
  omissionRows,
  omissionConflict,
} from "../helpers/file-jobs-browser.js";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

test("folder ZIP preparation uses an immutable download operation and proven artifact link", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  await page.routeWebSocket("**/api/**", (socket) => socket.close());
  f.onStart = (body) => {
    expect(body.kind).toBe("archive");
    expect(body.sources).toEqual(["/home/test/docs"]);
    expect(body.target).toBeNull();
    expect(body.options).toEqual({ output: "download" });
  };
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("checkbox", { name: "Select docs", exact: true }).check();
  await page.getByRole("button", { name: "Download as ZIP", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect.poll(() => f.jobs.size).toBe(1);
  const job = [...f.jobs.values()][0];
  await expect(
    page.getByRole("region", { name: "File jobs", exact: true }),
  ).toContainText("Preparing archive");
  f.finish(job.id, [], "completed");
  job.artifactReady = false;
  await expect(
    page.getByRole("link", { name: "Download archive", exact: true }),
  ).toHaveCount(0);
  job.artifactReady = true;
  await expect(
    page.getByRole("link", { name: "Download archive", exact: true }),
  ).toHaveAttribute("href", `/api/files/jobs/${job.id}/download`);
});

test("complete versioned omission review loads every page before explicit link consent", async ({
  page,
}) => {
  const f = await jobsFixture(page);
  f.onStart = (_, job) => {
    Object.assign(job, {
      status: "waiting_for_conflict",
      totalEntries: 201,
      conflict: omissionConflict(),
    });
    f.rows.set(job.id, omissionRows());
  };
  f.onResolve = (body, job) => {
    expect(body).toEqual({
      conflictId: "links-1",
      decision: "skip_links",
      applyToRemaining: false,
    });
    f.finish(job.id, f.rows.get(job.id));
  };
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page
    .getByRole("button", { name: "Download this folder as ZIP", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Review omitted entries" });
  await expect(dialog).toContainText("201 entries will be omitted.");
  expect(f.entryPages.some((item) => item.cursor === "entries-200")).toBe(true);
  const submit = dialog.getByRole("button", { name: "Create ZIP with these omissions" });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("button", { name: "Show more entry results" }).click();
  await expect(dialog).toContainText("link-200");
  await dialog.getByRole("checkbox").check();
  await submit.click();
  await expect(dialog).toHaveCount(0);
  expect(f.requests.filter((item) => item.suffix.endsWith("/resolve"))).toHaveLength(1);
});

for (const problem of ["mixed", "duplicate", "cycle", "stale", "truncated"]) {
  test(`omission consent rejects ${problem} archive pages`, async ({ page }) => {
    const f = await jobsFixture(page),
      rows = omissionRows();
    const job = f.addJob(
      {
        kind: "archive",
        status: "waiting_for_conflict",
        totalEntries: 201,
        conflict: omissionConflict(),
      },
      rows,
    );
    f.onPage = ({ offset }) => {
      if (problem === "truncated") return { entries: [rows[0]], nextCursor: null };
      if (!offset) return null;
      const row = { ...rows[200] };
      if (problem === "mixed") row.manifestVersion = "b".repeat(64);
      if (problem === "duplicate") row.id = "0";
      if (problem === "stale") job.conflict = omissionConflict("b".repeat(64), "links-2");
      return { entries: [row], nextCursor: problem === "cycle" ? "entries-200" : null };
    };
    await selectEnglish(page);
    await page.goto(baseURL + "/files");
    const dialog = page.getByRole("dialog", { name: "Review omitted entries" });
    await expect(
      dialog.getByRole("button", { name: "Create ZIP with these omissions" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Reload omission review" }),
    ).toBeVisible();
    expect(f.requests.filter((item) => item.suffix.endsWith("/resolve"))).toHaveLength(0);
  });
}

test("extract requests keep their empty options and support typed merge without changing Restore", async ({
  page,
}) => {
  const f = await jobsFixture(page);
  f.onStart = (body, job) => {
    expect(body).toMatchObject({
      kind: "extract",
      sources: ["/home/test/input.zip"],
      target: "/home/test/docs",
      name: null,
      options: {},
    });
    Object.assign(job, {
      status: "waiting_for_conflict",
      conflict: {
        id: "extract-merge",
        type: "name",
        sourceType: "directory",
        targetType: "directory",
        source: body.sources[0],
        target: "/home/test/docs/folder",
        choices: ["merge", "skip", "keep_both", "cancel"],
      },
    });
  };
  f.onResolve = (body, job) => {
    expect(body).toEqual({
      conflictId: "extract-merge",
      decision: "merge",
      applyToRemaining: true,
    });
    f.finish(job.id, [
      { id: "folder", path: "/home/test/docs/folder", status: "skipped" },
    ]);
  };
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("checkbox", { name: "Select input.zip", exact: true }).check();
  await page.getByRole("button", { name: "Extract to folder …", exact: true }).click();
  await page.getByLabel("Destination folder", { exact: true }).fill("/home/test/docs");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  const conflict = page.getByRole("dialog", { name: "File conflict" });
  await expect(conflict).toContainText("keeps its owner");
  await conflict.getByRole("checkbox").check();
  await conflict.getByRole("button", { name: "Merge folders" }).click();
  await expect(conflict).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "File jobs", exact: true }),
  ).toContainText("Skipped");
});

test("read-only scope permits selection ZIP download and disables archive writes and extraction", async ({
  page,
}) => {
  const f = await jobsFixture(page, { readOnly: true });
  f.onStart = (body) =>
    expect(body).toMatchObject({
      kind: "archive",
      target: null,
      options: { output: "download" },
    });
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("checkbox", { name: "Select input.zip", exact: true }).check();
  for (const name of ["Create ZIP", "Extract here", "Extract to folder …"])
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Download as ZIP", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect.poll(() => f.jobs.size).toBe(1);
});

test("real app creates and downloads a job-bound ZIP with desktop and mobile evidence", async ({
  page,
  request,
}, testInfo) => {
  await page.routeWebSocket("**/api/**", (socket) => socket.close());
  const context = await (await request.get(baseURL + "/api/files/context")).json();
  expect(context.home).toContain("agentpier-browser-server-");
  const folder = `${context.home}/task17-${randomUUID()}`;
  const start = async (kind, target, name) => {
    const response = await request.post(baseURL + "/api/files/operations", {
      headers: { "X-File-Scope": context.scopeId, Origin: baseURL },
      data: {
        requestId: `${Date.now()}:${randomUUID()}`,
        kind,
        sources: [],
        target,
        name,
        options: {},
      },
    });
    expect(response.status()).toBe(202);
    const job = await response.json();
    await expect
      .poll(
        async () =>
          (await (await request.get(`${baseURL}/api/files/jobs/${job.id}`)).json())
            .status,
      )
      .toBe("completed");
  };
  await start("create_directory", context.home, folder.split("/").at(-1));
  await start("create_file", folder, "proof.txt");
  await selectEnglish(page);
  await page.goto(`${baseURL}/files?path=${encodeURIComponent(folder)}`);
  await page.getByRole("checkbox", { name: "Select proof.txt", exact: true }).check();
  await page.getByRole("button", { name: "Download as ZIP", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  const link = page.getByRole("link", { name: "Download archive", exact: true }).last();
  await expect(link).toBeVisible();
  const card = page.locator(".file-job-card").filter({ has: link });
  await card.getByRole("button", { name: "Load entry results", exact: true }).click();
  const result = card
    .getByRole("region", { name: "Completed entries", exact: true })
    .getByRole("listitem");
  await expect(result).toContainText("proof.txt");
  await page.screenshot({
    path: testInfo.outputPath("archive-desktop-en.png"),
    fullPage: true,
  });
  const pending = page.waitForEvent("download");
  await link.click();
  const download = await pending;
  const data = await fs.readFile(await download.path());
  expect(data.subarray(0, 2).toString()).toBe("PK");
  expect(data.includes(Buffer.from("proof.txt"))).toBe(true);
  expect(await download.failure()).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await expect(page.locator(".nav-backdrop")).not.toBeVisible();
  await result.scrollIntoViewIfNeeded();
  await expect(result).toBeInViewport();
  await expect(link).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("archive-mobile-en.png"),
    fullPage: true,
  });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    )
    .toBe(true);
});
