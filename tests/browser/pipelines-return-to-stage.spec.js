import { test, expect } from "../helpers/browser-test.js";
import { pipelinesFixture, openPipelines, sampleRun } from "./pipelines-fixture.js";

// Return to stage (ReturnToStage) on a finished run against mocked return, diff and
// review-comment routes: the return to a chosen stage with the open notes, a blocked
// run's reason without a form, a busy project's answer that keeps the form, Return
// waiting for text or notes, and the phone width.
test.use({ locale: "en-GB" });

const shots = process.env.RETURN_TO_STAGE_SCREENSHOTS;
const stamp = "2026-11-04T10:00:00.000Z";
const note = (id, line, body) => ({
  id,
  file: "src/app.js",
  workspace: "",
  side: "new",
  line,
  anchor: { side: "new", line, text: "", before: [], after: [], excerpt: [] },
  body,
  status: "open",
  createdAt: stamp,
  updatedAt: stamp,
  sentIn: null,
});

const appFile = {
  path: "src/app.js",
  oldPath: null,
  status: "modified",
  binary: false,
  added: 1,
  removed: 0,
  rows: [
    { kind: "meta", text: "@@ -1,1 +1,2 @@" },
    {
      kind: "context",
      text: "import { start } from './start.js';",
      oldLine: 1,
      newLine: 1,
    },
    { kind: "add", text: "start(port);", newLine: 2 },
  ],
  rowsTruncated: false,
};

// A completed two-stage run that offers Return to stage; `options` is the GET answer,
// `post` an optional failure for the POST. Returns the mock.
async function setup(page, { options = {}, comments = [], post = null } = {}) {
  const state = await pipelinesFixture(page);
  const run = sampleRun(state);
  run.status = "completed";
  run.currentNodeId = null;
  run.nodes = [
    { ...run.nodes[0], id: "build", status: "passed", verdict: { result: "pass" } },
    {
      ...run.nodes[0],
      id: "review",
      profileSnapshot: { ...run.nodes[0].profileSnapshot, name: "Review" },
      status: "passed",
      verdict: { result: "pass" },
    },
  ];
  run.workingDir = "/fixture/worktree";
  run.actions = ["delete", "return-to-stage"];
  state.runs.push(run);
  const mock = {
    run,
    comments,
    options: {
      available: true,
      reason: null,
      stages: [
        { id: "build", name: "Build" },
        { id: "review", name: "Review" },
      ],
      openComments: comments.length,
      ...options,
    },
    post,
    posts: [],
  };
  await page.route("**/api/pipeline-runs/run-one/diff", (route) =>
    route.fulfill({
      json: {
        from: "a".repeat(40),
        files: [appFile],
        truncated: false,
        fingerprint: "f0",
      },
    }),
  );
  await page.route("**/api/pipeline-runs/run-one/review-comments", (route) =>
    route.fulfill({ json: { comments: mock.comments, batches: 0 } }),
  );
  await page.route("**/api/pipeline-runs/run-one/return-to-stage", (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fulfill({ json: mock.options });
    mock.posts.push(request.postDataJSON());
    if (mock.post) return route.fulfill(mock.post);
    run.status = "running";
    run.currentNodeId = request.postDataJSON().nodeId;
    run.actions = ["abort"];
    return route.fulfill({ json: { run } });
  });
  await openPipelines(page, "runs/run-one");
  await expect(page.getByText("Review the application").first()).toBeVisible();
  return mock;
}

const openDialog = (page) =>
  page.getByRole("button", { name: "Return to stage …" }).click();
const dialog = (page) => page.getByRole("dialog", { name: /to a stage$/ });
const returnButton = (page) =>
  dialog(page).getByRole("button", { name: "Return", exact: true });
const field = (page) => dialog(page).getByLabel("What should the stage change?");

test("a finished run returns to a chosen stage with the review notes", async ({
  page,
}) => {
  const mock = await setup(page, {
    comments: [note("n1", 2, "Read the port once"), note("n2", 3, "Name the port")],
  });
  // the run's comments are writable for the return
  await page.getByRole("button", { name: "Review changes" }).click();
  await page
    .getByRole("region", { name: "Diff of src/app.js" })
    .getByText("start(port);")
    .click();
  await expect(page.getByRole("button", { name: "Comment on line 2" })).toBeVisible();
  await openDialog(page);
  await expect(
    dialog(page).getByText("2 open comments will be sent with the feedback"),
  ).toBeVisible();
  await dialog(page).getByRole("combobox", { name: "Stage" }).click();
  await page.getByRole("option", { name: "Review" }).click();
  await field(page).fill("Tighten the error handling");
  if (shots) await page.screenshot({ path: `${shots}/return-dialog.png` });
  const request = page.waitForRequest(
    (r) => r.url().endsWith("/return-to-stage") && r.method() === "POST",
  );
  await returnButton(page).click();
  const body = (await request).postDataJSON();
  expect(body).toMatchObject({
    nodeId: "review",
    feedback: "Tighten the error handling",
    review: true,
  });
  expect(body.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Return to stage …" })).toHaveCount(0);
  expect(mock.posts).toHaveLength(1);
});

test("a blocked return says why and offers no form", async ({ page }) => {
  await setup(page, { options: { available: false, reason: "pr-merged" } });
  await openDialog(page);
  await expect(dialog(page).getByText("The pull request was merged.")).toBeVisible();
  await expect(returnButton(page)).toHaveCount(0);
  await expect(dialog(page).getByRole("combobox", { name: "Stage" })).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test("a busy project says so and keeps the form", async ({ page }) => {
  const mock = await setup(page, {
    post: {
      status: 409,
      json: {
        code: "PIPELINE_RETURN_BUSY",
        error: "Das Projekt hat keinen freien Platz für Läufe.",
        messageKey: "pipelines.returnBusy",
      },
    },
  });
  await openDialog(page);
  await field(page).fill("Tighten the error handling");
  await returnButton(page).click();
  await expect(dialog(page).getByRole("alert")).toHaveText(
    "The project has no free run slot. Try again when a run finishes.",
  );
  await expect(field(page)).toHaveValue("Tighten the error handling");
  // the same opening tries again with the same request id
  mock.post = null;
  await returnButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(mock.posts).toHaveLength(2);
  expect(mock.posts[1].requestId).toBe(mock.posts[0].requestId);
  expect(mock.posts[1].nodeId).toBe("build");
});

test("Return waits for text or open notes", async ({ page }) => {
  await setup(page);
  await openDialog(page);
  await expect(returnButton(page)).toBeDisabled();
  await expect(dialog(page).getByText(/will be sent with the feedback/)).toHaveCount(0);
  await field(page).fill("   ");
  await expect(returnButton(page)).toBeDisabled();
  await field(page).fill("Fix the port");
  await expect(returnButton(page)).toBeEnabled();
});

test("the dialog fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, { comments: [note("n1", 2, "Read the port once")] });
  await openDialog(page);
  await expect(returnButton(page)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
