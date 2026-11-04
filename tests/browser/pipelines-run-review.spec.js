import { test, expect } from "../helpers/browser-test.js";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

// The run's Changes view (RunChanges) against mocked whole-run diff and review-comment
// routes: closed by default, comments while a gate waits, read-only otherwise, the
// gone and imported answers, a failed refresh, re-reads on run pushes, the stage diff
// tile in the shared renderer and the phone width.
test.use({ locale: "en-GB" });

const shots = process.env.RUN_CHANGES_SCREENSHOTS;
const stamp = "2026-11-04T10:00:00.000Z";
const row = (kind, text, oldLine, newLine) => ({
  kind,
  text,
  ...(oldLine ? { oldLine } : {}),
  ...(newLine ? { newLine } : {}),
});
const appFile = (added = "start(port);") => ({
  path: "src/app.js",
  oldPath: null,
  status: "modified",
  binary: false,
  added: 2,
  removed: 1,
  rows: [
    row("meta", "@@ -1,3 +1,4 @@"),
    row("context", "import { start } from './start.js';", 1, 1),
    row("remove", "start(8080);", 2),
    row("add", "const port = Number(process.env.PORT) || 8080;", 0, 2),
    row("add", added, 0, 3),
    row("context", "export default start;", 3, 4),
  ],
  rowsTruncated: false,
});

// The pipelines fixture with one run plus the run's diff and comment routes; `options`
// adjust the run. Returns the mock, whose answers a test may change.
async function setup(page, { run: adjust } = {}) {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  adjust?.(run);
  state.runs.push(run);
  const mock = {
    state,
    run,
    answer: { files: [appFile()], truncated: false, fingerprint: "f0" },
    failure: null,
    diffReads: 0,
    comments: [],
    creates: [],
  };
  await page.route("**/api/pipeline-runs/run-one/diff", (route) => {
    mock.diffReads++;
    if (mock.failure) return route.fulfill(mock.failure);
    return route.fulfill({ json: { from: "a".repeat(40), ...mock.answer } });
  });
  await page.route("**/api/pipeline-runs/run-one/review-comments", (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const input = request.postDataJSON();
      mock.creates.push(input);
      const comment = {
        id: `c${mock.creates.length}`,
        ...input,
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
        sentIn: null,
      };
      mock.comments.push(comment);
      return route.fulfill({ status: 201, json: comment });
    }
    return route.fulfill({ json: { comments: mock.comments, batches: 0 } });
  });
  await openPipelines(page, "runs/run-one");
  await expect(page.getByText("Missing validation", { exact: false })).toBeVisible();
  return mock;
}

const reviewButton = (page) => page.getByRole("button", { name: "Review changes" });
const appRegion = (page) => page.getByRole("region", { name: "Diff of src/app.js" });
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("the run's changes open on demand and take comments", async ({ page }) => {
  const mock = await setup(page);
  await expect(reviewButton(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("region", { name: /Diff of/ })).toHaveCount(0);
  expect(mock.diffReads).toBe(0);

  await reviewButton(page).click();
  await expect(reviewButton(page)).toHaveAttribute("aria-expanded", "true");
  await expect(appRegion(page).getByText("start(port);")).toBeVisible();
  expect(mock.diffReads).toBe(1);

  await appRegion(page).getByText("start(port);").click();
  await page.getByRole("button", { name: "Comment on line 3" }).click();
  await page.getByLabel("Comment (Markdown)").fill("Read the port once");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("1 open review note")).toBeVisible();
  await expect(appRegion(page).getByText("Read the port once")).toBeVisible();
  expect(mock.creates).toEqual([
    expect.objectContaining({ file: "src/app.js", line: 3, side: "new", workspace: "" }),
  ]);
  if (shots) await page.screenshot({ path: `${shots}/run-changes-en.png` });

  // closing keeps the count beside the button
  await reviewButton(page).click();
  await expect(appRegion(page)).toHaveCount(0);
  await expect(page.getByText("1 open review note")).toBeVisible();
});

test("Refresh and run pushes read the diff again", async ({ page, liveStub }) => {
  const mock = await setup(page);
  await reviewButton(page).click();
  await expect(appRegion(page).getByText("start(port);")).toBeVisible();

  // an edit that keeps the counts shows on Refresh changes
  mock.answer = { files: [appFile("start(port, host);")], fingerprint: "f1" };
  await page.getByRole("button", { name: "Refresh changes" }).click();
  await expect(appRegion(page).getByText("start(port, host);")).toBeVisible();
  expect(mock.diffReads).toBe(2);

  // a push that changes the stage's attempts reads again
  mock.answer = { files: [appFile("start(port, host, tls);")], fingerprint: "f2" };
  mock.run.executionLog = [{ id: "attempt-1", nodeId: "stage-one", kind: "stage" }];
  await liveStub.reread("pipeline.run:run-one");
  await expect(appRegion(page).getByText("start(port, host, tls);")).toBeVisible();
  expect(mock.diffReads).toBe(3);

  // a push without a status, stage or attempt change does not
  mock.run.usage = { ...mock.run.usage, totalTokens: 1600 };
  await liveStub.reread("pipeline.run:run-one");
  await expect(page.getByText("1,600").first()).toBeVisible();
  expect(mock.diffReads).toBe(3);
});

test("a failed refresh keeps the diff beside the error", async ({ page }) => {
  const mock = await setup(page);
  await reviewButton(page).click();
  await expect(appRegion(page)).toBeVisible();
  mock.failure = { status: 500, json: { error: "Git is busy." } };
  await page.getByRole("button", { name: "Refresh changes" }).click();
  await expect(page.getByText("Git is busy.")).toBeVisible();
  await expect(appRegion(page).getByText("start(port);")).toBeVisible();
  mock.failure = null;
  await page.getByRole("button", { name: "Refresh changes" }).click();
  await expect(page.getByText("Git is busy.")).toHaveCount(0);
});

test("without a waiting gate the changes are read-only", async ({ page }) => {
  await setup(page, {
    run: (run) => {
      run.status = "running";
      run.nodes[0].status = "running";
      run.actions = ["abort"];
    },
  });
  await reviewButton(page).click();
  await appRegion(page).getByText("start(port);").click();
  await expect(page.getByRole("button", { name: /Comment on line/ })).toHaveCount(0);
});

test("a gone worktree says so", async ({ page }) => {
  const mock = await setup(page);
  mock.failure = {
    status: 409,
    json: { error: "gone", code: "PIPELINE_RUN_WORKSPACE_GONE" },
  };
  await reviewButton(page).click();
  await expect(page.getByText("The run's worktree is gone")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh changes" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an imported run shows no changes", async ({ page }) => {
  const mock = await setup(page);
  mock.failure = {
    status: 409,
    json: { error: "imported", code: "PIPELINE_RUN_IMPORTED" },
  };
  await reviewButton(page).click();
  await expect(reviewButton(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a history-only run offers no review", async ({ page }) => {
  const mock = await setup(page, {
    run: (run) => {
      run.imported = { historyOnly: true };
    },
  });
  await expect(reviewButton(page)).toHaveCount(0);
  expect(mock.diffReads).toBe(0);
});

test("a stage's diff tile shows rows, read-only", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".diff-row.is-add").first()).toContainText("new line");
  await expect(dialog.locator(".diff-row.is-remove").first()).toContainText("old line");
  await dialog.locator(".diff-row.is-add").first().click();
  await expect(page.getByRole("button", { name: /Comment on line/ })).toHaveCount(0);
});

test("the open changes fit a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await reviewButton(page).click();
  await expect(appRegion(page)).toBeVisible();
  await page.getByRole("button", { name: "Review changes" }).scrollIntoViewIfNeeded();
  expect(await noOverflow(page)).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/run-changes-en-phone.png` });
});
