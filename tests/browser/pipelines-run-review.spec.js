import { test, expect } from "../helpers/browser-test.js";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

// The run's Changes view (RunChanges) against mocked whole-run diff and review-comment
// routes: closed by default, comments while a decision that carries them waits,
// read-only otherwise (a budget gate too), the gone and imported answers, a failed
// refresh, re-reads on run pushes, the stage diff tile in the shared renderer and the
// phone width. The gate forms (GateDecision, a
// group member's actions) send the open notes with `review: true` and stop feedback
// that would exceed the server's 32 KB limit.
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

// The search button names its shortcut by platform: ⌘K on macOS, Ctrl+K elsewhere.
const searchButton = (page) =>
  page.getByRole("button", { name: /^Search \((⌘|Ctrl\+)K\)$/ });

// The pipelines fixture with one run plus the run's diff and comment routes; `options`
// adjust the run. Returns the mock, whose answers a test may change.
async function setup(page, { run: adjust, comments = [] } = {}) {
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
    comments,
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
  await expect(page.getByText("Review the application").first()).toBeVisible();
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
  await expect(reviewButton(page).locator(".run-changes-cue")).toHaveText("▸");
  expect(mock.diffReads).toBe(0);

  await reviewButton(page).click();
  await expect(reviewButton(page)).toHaveAttribute("aria-expanded", "true");
  await expect(reviewButton(page).locator(".run-changes-cue")).toHaveText("▾");
  await expect(appRegion(page).getByText("start(port);")).toBeVisible();
  expect(mock.diffReads).toBe(1);

  await appRegion(page).getByText("start(port);").click();
  await page.getByRole("button", { name: "Comment on line 3" }).click();
  await page.getByLabel("Comment (Markdown)").fill("Read the port once");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("1 open comment", { exact: true })).toBeVisible();
  await expect(appRegion(page).getByText("Read the port once")).toBeVisible();
  expect(mock.creates).toEqual([
    expect.objectContaining({ file: "src/app.js", line: 3, side: "new", workspace: "" }),
  ]);
  if (shots) await page.screenshot({ path: `${shots}/run-changes-en.png` });

  // closing keeps the count beside the button
  await reviewButton(page).click();
  await expect(appRegion(page)).toHaveCount(0);
  await expect(page.getByText("1 open comment", { exact: true })).toBeVisible();
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

test("a budget gate keeps the changes read-only", async ({ page }) => {
  await setup(page, {
    run: (run) => {
      run.tokenBudget = 1000;
      run.nodes[0].verdict = undefined;
      run.nodes[0].failReason = "budget-exceeded";
      run.actions = ["abort", "raise-budget"];
    },
  });
  // the gate waits, but no decision there can send comments
  await expect(page.getByRole("textbox", { name: "New token budget" })).toBeVisible();
  await reviewButton(page).click();
  await appRegion(page).getByText("start(port);").click();
  await expect(page.getByRole("button", { name: /Comment on line/ })).toHaveCount(0);
});

// A run whose parallel group waits on one member's decision, not on a run gate.
function groupGate(run) {
  run.status = "running";
  run.currentNodeId = "review";
  run.actions = ["abort"];
  run.memberActions = {};
  run.nodes = [
    { ...run.nodes[0], status: "passed" },
    {
      id: "review",
      kind: "parallel",
      members: ["security", "ux"],
      concurrency: 2,
      label: "Security · UX",
      status: "running",
    },
    {
      id: "security",
      group: "review",
      profileSnapshot: { ...run.nodes[0].profileSnapshot, name: "Security" },
      status: "reported",
      verdict: { result: "fail", summary: "Injection risk", requiresHuman: true },
    },
    {
      id: "ux",
      group: "review",
      profileSnapshot: { ...run.nodes[0].profileSnapshot, name: "UX" },
      status: "running",
    },
  ];
}

test("a waiting group member makes the changes writable", async ({ page, liveStub }) => {
  const mock = await setup(page, { run: groupGate });
  await reviewButton(page).click();
  await appRegion(page).getByText("start(port);").click();
  await expect(page.getByRole("button", { name: /Comment on line/ })).toHaveCount(0);
  expect(mock.diffReads).toBe(1);

  // the member starts to wait: the push reads the diff again and comments open
  mock.run.memberActions = { security: ["feedback"] };
  await liveStub.reread("pipeline.run:run-one");
  await expect.poll(() => mock.diffReads).toBe(2);
  await appRegion(page).getByText("start(port);").click();
  await page.getByRole("button", { name: "Comment on line 3" }).click();
  await expect(page.getByLabel("Comment (Markdown)")).toBeVisible();
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
  // nor does ⌘K
  await page.route(
    /\/api\/(ssh-accesses|mcp-servers|secrets|repositories|inbox)$/,
    (route) => route.fulfill({ status: 404, json: { error: "none" } }),
  );
  await searchButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  // the search answers (a page is found), then the action is not among the results
  await dialog.getByRole("combobox").fill("Pipelines");
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await dialog.getByRole("combobox").fill("Review changes");
  await expect(dialog.getByRole("option")).toHaveCount(0);
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

// Open comments on src/app.js; `resolved` adds one that is not sent.
const note = (id, line, body, status = "open") => ({
  id,
  file: "src/app.js",
  workspace: "",
  side: "new",
  line,
  anchor: { side: "new", line, text: "", before: [], after: [], excerpt: [] },
  body,
  status,
  createdAt: stamp,
  updatedAt: stamp,
  sentIn: null,
});
const notes = () => [
  note("n1", 2, "Read the port once"),
  note("n2", 3, "Name the port"),
  note("n3", 4, "Done already", "resolved"),
];
const gateRequest = (page) =>
  page.waitForRequest((r) => r.url().endsWith("/gate") && r.method() === "POST");
const retry = (page) =>
  page.getByRole("button", { name: "Retry with feedback", exact: true });

test("a waiting gate sends the open comments with its feedback", async ({ page }) => {
  const mock = await setup(page, { comments: notes() });
  await expect(
    page.getByText("2 open comments will be sent with the feedback"),
  ).toBeVisible();
  await expect(page.getByLabel("Feedback", { exact: true })).toHaveAccessibleDescription(
    "2 open comments will be sent with the feedback",
  );
  // the size check reads the run's diff to place the notes as the server does
  await expect.poll(() => mock.diffReads).toBe(1);
  const request = gateRequest(page);
  await retry(page).click(); // enabled without text
  expect((await request).postDataJSON()).toEqual({
    action: "feedback",
    feedback: "",
    review: true,
  });
});

test("Return for repair carries the notes too", async ({ page }) => {
  await setup(page, { comments: notes() });
  const request = gateRequest(page);
  await page.getByRole("button", { name: "Return for repair", exact: true }).click();
  expect((await request).postDataJSON()).toEqual({
    action: "loop-back",
    feedback: "",
    review: true,
  });
});

test("without open notes Retry with feedback needs text", async ({ page }) => {
  const mock = await setup(page);
  await expect(retry(page)).toBeDisabled();
  await expect(page.getByText(/will be sent with the feedback/)).toHaveCount(0);
  expect(mock.diffReads).toBe(0);
});

test("too much feedback is stopped before sending", async ({ page }) => {
  await setup(page, { comments: notes() });
  const field = page.getByLabel("Feedback", { exact: true });
  // the live region is there, empty, before the notice, so the notice is announced
  const size = page.locator(".run-gate-decision [role=status].gate-review-size");
  await expect(size).toHaveCount(1);
  await expect(size).toHaveText("");
  await field.fill("ä".repeat(16400));
  await expect(size).toHaveText(/together exceed 32 KB/);
  // in the guide's warning tone
  expect(
    await size.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--warning)";
      document.body.append(probe);
      const warning = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(element).color === warning;
    }),
  ).toBe(true);
  await expect(retry(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Return for repair", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/together exceed 32 KB/)).toBeVisible();
  await field.scrollIntoViewIfNeeded();
  if (shots) await page.screenshot({ path: `${shots}/gate-batch-en.png` });
  await field.fill("Shorter");
  await expect(retry(page)).toBeEnabled();
  await expect(page.getByText(/together exceed 32 KB/)).toHaveCount(0);
});

test("the gate form fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, { comments: notes() });
  await page.getByLabel("Feedback", { exact: true }).fill("ä".repeat(16400));
  await expect(page.getByText(/together exceed 32 KB/)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("a waiting group member's feedback carries the notes", async ({ page }) => {
  await setup(page, {
    comments: notes(),
    run: (run) => {
      groupGate(run);
      run.memberActions = { security: ["feedback"] };
    },
  });
  const card = page.locator(".run-group-member").filter({ hasText: "Security" });
  await expect(
    card.getByText("2 open comments will be sent with the feedback"),
  ).toBeVisible();
  const send = card.getByRole("button", { name: "Retry with feedback · Security" });
  await card.getByLabel("Feedback for Security").fill("ä".repeat(16400));
  await expect(send).toBeDisabled();
  await expect(card.getByText(/together exceed 32 KB/)).toBeVisible();
  await card.getByLabel("Feedback for Security").fill("");
  const request = gateRequest(page);
  await send.click(); // enabled without text
  expect((await request).postDataJSON()).toEqual({
    action: "feedback",
    nodeId: "security",
    feedback: "",
    review: true,
  });
});

test("⌘K Review changes opens the run's changes", async ({ page }) => {
  await setup(page);
  // The search also reads connection names and the inbox; none here.
  await page.route(
    /\/api\/(ssh-accesses|mcp-servers|secrets|repositories|inbox)$/,
    (route) => route.fulfill({ status: 404, json: { error: "none" } }),
  );
  await searchButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  await dialog.getByRole("combobox").fill("Review changes");
  await dialog
    .getByRole("group", { name: "Actions" })
    .getByRole("option", { name: /Review changes/ })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(reviewButton(page)).toHaveAttribute("aria-expanded", "true");
  await expect(reviewButton(page)).toBeFocused();
  await expect(appRegion(page).getByText("start(port);")).toBeVisible();
});
