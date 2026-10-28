import { openExplorerPanel } from "../helpers/file-explorer-layout.js";
import { test, expect } from "../helpers/browser-test.js";
import { actionsFixture } from "../helpers/file-actions-browser.js";
import { explorerContext, selectEnglish } from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";

// The explorer's job envelopes arrive on the live topic files.jobs; result pages are
// read over REST once per job version (docs/file-explorer.md).

test.use({ live: "manual" });

const copyJob = (id) => ({
  id,
  scopeId: explorerContext.scopeId,
  kind: "copy",
  status: "running",
  completedEntries: 0,
  totalEntries: 2,
  completedBytes: 0,
  totalBytes: null,
  conflict: null,
  issue: null,
  updatedAt: 1,
});

test("a copy job's progress arrives pushed and its results are read per version", async ({
  page,
  liveStub,
}) => {
  const f = await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await openExplorerPanel(page, "activity");
  await liveStub.waitForSubscribe("files.jobs:global");
  const job = copyJob("pushed");
  f.jobs.set(job.id, job);
  f.rows.set(job.id, []);
  const push = (changes) => {
    Object.assign(job, changes);
    liveStub.push("files.jobs:global", { jobs: [{ ...job }], nextCursor: null });
  };
  const heading = page.locator('[data-job-id="pushed"] .file-job-heading');
  const pages = () =>
    f.requests.filter((item) => item.suffix === "/jobs/pushed/entries").length;
  push({});
  await expect(heading).toContainText("Running");
  await expect.poll(pages).toBe(1);
  push({ completedEntries: 1, updatedAt: 2 });
  await expect.poll(pages).toBe(2);
  f.rows.set(job.id, [
    { id: "0", path: "/home/test/docs/a.txt", type: "file", status: "completed" },
    { id: "1", path: "/home/test/docs/b.txt", type: "file", status: "completed" },
  ]);
  push({ status: "completed", completedEntries: 2, updatedAt: 3 });
  await expect(heading).toContainText("Completed");
  await expect.poll(pages).toBe(3);
  // The same version again reads nothing; the envelopes came only by push.
  push({});
  await page.waitForTimeout(2000);
  expect(pages()).toBe(3);
  expect(f.requests.some((item) => item.suffix === "/jobs/pushed")).toBe(false);
});

test("a running job beyond the first 200 follows its pushes without polling", async ({
  page,
  liveStub,
}) => {
  const f = await actionsFixture(page);
  const old = Array.from({ length: 200 }, (_, index) => ({
    ...copyJob(`old-${index}`),
    status: "completed",
    completedEntries: 2,
  }));
  for (const job of old) {
    f.jobs.set(job.id, job);
    f.rows.set(job.id, []);
  }
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await openExplorerPanel(page, "activity");
  await liveStub.waitForSubscribe("files.jobs:global");
  const job = copyJob("beyond");
  f.jobs.set(job.id, job);
  f.rows.set(job.id, []);
  const push = (changes) => {
    Object.assign(job, changes);
    liveStub.push("files.jobs:global", {
      jobs: old,
      nextCursor: "jobs-200",
      active: job.status === "completed" ? [] : [{ ...job }],
    });
  };
  const pages = () =>
    f.requests.filter((item) => item.suffix === "/jobs/beyond/entries").length;
  push({});
  await expect.poll(pages).toBe(1);
  push({ completedEntries: 1, updatedAt: 2 });
  await expect.poll(pages).toBe(2);
  // Nothing moves for longer than the former 1.5 s poll: nothing is read.
  await page.waitForTimeout(3500);
  expect(pages()).toBe(2);
  expect(f.requests.some((item) => item.suffix === "/jobs/beyond")).toBe(false);
});
