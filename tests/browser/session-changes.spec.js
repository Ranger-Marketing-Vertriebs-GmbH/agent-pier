import { test, expect } from "../helpers/browser-test.js";
import { fixture, stamp } from "../helpers/repository-browser.js";
import { baseURL } from "../helpers/browser.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";

// The session Changes tab against mocked changes and review-comment routes: the badge,
// the workspace picker and base lines, the 404 fallback, a plain folder, the save that
// survives a refresh, and the phone width.
test.use({ locale: "en-GB" });

const id = "changes-session";
const sha = (char) => char.repeat(40);
const tree = ".worktrees/feat/x";
const shots = process.env.CHANGES_SCREENSHOTS;

const row = (kind, text, oldLine, newLine) => ({
  kind,
  text,
  ...(oldLine ? { oldLine } : {}),
  ...(newLine ? { newLine } : {}),
});
const appFile = (extra = []) => ({
  path: "src/app.js",
  oldPath: null,
  status: "modified",
  binary: false,
  added: 2 + extra.length,
  removed: 1,
  rows: [
    row("meta", "@@ -1,3 +1,4 @@"),
    ...extra,
    row("context", "import { start } from './start.js';", 1, 1 + extra.length),
    row("remove", "start(8080);", 2),
    row("add", "const port = Number(process.env.PORT) || 8080;", 0, 2 + extra.length),
    row("add", "start(port);", 0, 3 + extra.length),
    row("context", "export default start;", 3, 4 + extra.length),
  ],
  rowsTruncated: false,
});
const treeFile = {
  path: "README.md",
  oldPath: null,
  status: "added",
  binary: false,
  added: 1,
  removed: 0,
  rows: [row("meta", "@@ -0,0 +1 @@"), row("add", "# Feature X", 0, 1)],
  rowsTruncated: false,
};

const notesFile = {
  ...treeFile,
  path: "docs/notes.md",
  status: "modified",
  rows: [
    row("meta", "@@ -1 +1,2 @@"),
    row("context", "# Notes", 1, 1),
    row("add", "Read the port from the environment.", 0, 2),
  ],
};

function summaryOf({
  source = "start",
  extra = 0,
  withTree = true,
  fingerprint = "f0",
} = {}) {
  const workspaces = [
    {
      id: "",
      branch: "main",
      base: { kind: "start-commit", sha: sha("a") },
      files: 2,
      added: 3 + extra,
      removed: 1,
      fingerprint,
    },
    ...(withTree
      ? [
          {
            id: tree,
            branch: "feat/x",
            base: { kind: "merge-base", sha: sha("b"), ref: "refs/remotes/origin/main" },
            files: 1,
            added: 1,
            removed: 0,
          },
        ]
      : []),
  ];
  return {
    repository: true,
    startCommit: { sha: sha("a"), source },
    workspaces,
    changedFiles: workspaces.reduce((sum, w) => sum + w.files, 0),
  };
}

// Mocks the session and its changes routes; `options.summary` and `options.diffs` may
// be replaced during a test. Returns the recorded requests.
async function setup(page, options = {}) {
  const { state } = await fixture(page);
  state.sessions.push({
    id,
    name: "Changes fixture",
    tool: "shell",
    cwd: "/home/test/project",
    status: "running",
    accountId: "local-shell",
    createdAt: stamp,
    ...options.session,
  });
  const mock = {
    summary: options.summary ?? summaryOf(),
    diffs: {
      "": [appFile(), notesFile],
      [tree]: [treeFile],
    },
    comments: options.comments ?? [],
    batches: 0,
    sent: [],
    hold: null,
    summaryReads: 0,
    diffReads: [],
    creates: [],
  };
  const chat = { availability: "ready", messages: [], tasks: [] };
  await mockChatStream(page, () => chat);
  await page.route(`**/api/sessions/${id}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const rest = url.pathname.slice(`/api/sessions/${id}`.length);
    if (rest === "/changes") {
      mock.summaryReads++;
      return route.fulfill({ json: mock.summary });
    }
    if (rest === "/changes/diff") {
      const workspace = url.searchParams.get("workspace");
      mock.diffReads.push(workspace);
      if (mock.diffFails)
        return route.fulfill({ status: 500, json: { error: "Git is busy." } });
      const files = mock.diffs[workspace];
      if (!files)
        return route.fulfill({
          status: 404,
          json: { error: "This workspace no longer exists. Reload the changes." },
        });
      const entry = mock.summary.workspaces.find((w) => w.id === workspace);
      return route.fulfill({
        json: { workspace, base: entry?.base, files, truncated: false },
      });
    }
    if (rest === "/review-comments" && request.method() === "POST") {
      const input = request.postDataJSON();
      mock.creates.push(input);
      if (mock.hold) await mock.hold;
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
    if (rest === "/chat") return route.fulfill({ json: chat });
    if (rest === "/models")
      return route.fulfill({
        json: { currentModel: null, picker: null, pending: false },
      });
    if (rest === "/github")
      return route.fulfill({ json: { configured: true, hosts: [], remote: null } });
    if (rest === "/review-comments/sent") {
      const { ids } = request.postDataJSON();
      if (mock.markFails)
        return route.fulfill({ status: 500, json: { error: "Marking failed." } });
      mock.sent.push(ids);
      const batch = ++mock.batches;
      for (const comment of mock.comments)
        if (ids.includes(comment.id)) comment.sentIn = batch;
      return route.fulfill({ json: { batch } });
    }
    if (rest === "/review-comments")
      return route.fulfill({ json: { comments: mock.comments, batches: mock.batches } });
    return route.fallback();
  });
  return mock;
}

const changesTab = (page) =>
  page.locator(".terminal-topbar .segmented").getByRole("button", { name: /^Changes/ });
const appRegion = (page) => page.getByRole("region", { name: "Diff of src/app.js" });

test("the tab stays closed until opened, then shows the picked workspace", async ({
  page,
}) => {
  const mock = await setup(page);
  await page.goto(`${baseURL}/sessions/${id}`);
  const tabs = page.locator(".terminal-topbar .segmented");
  await expect(tabs.getByRole("button", { name: "Terminal" })).toHaveClass(/selected/);
  await expect(changesTab(page)).toHaveAccessibleName("Changes, 3 changed files");
  await expect(changesTab(page).locator(".badge")).toHaveText("3");
  await expect(changesTab(page)).not.toHaveClass(/selected/);
  expect(mock.diffReads).toEqual([]);

  await changesTab(page).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${id}/changes$`));
  await expect(changesTab(page)).toHaveClass(/selected/);
  await expect(page.getByText("Since the session started")).toBeVisible();
  await expect(appRegion(page)).toBeVisible();
  await expect(appRegion(page).getByText("start(port);")).toBeVisible();
  expect(mock.diffReads).toEqual([""]);
  const picker = page.getByRole("combobox", { name: "Workspace" });
  await expect(picker).toHaveValue("");
  // the connection pill belongs to the terminal
  await expect(page.locator(".terminal-topbar .connection")).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/changes-tab-en.png` });

  await picker.selectOption(tree);
  await expect(page.getByText("Since the branch point with main")).toBeVisible();
  await expect(page.getByRole("region", { name: "Diff of README.md" })).toBeVisible();
  expect(mock.diffReads).toEqual(["", tree]);

  // a reload lands on the tab again
  await page.reload();
  await expect(changesTab(page)).toHaveClass(/selected/);
  await expect(appRegion(page)).toBeVisible();
});

test("a session viewed first after the update names that base", async ({ page }) => {
  await setup(page, { summary: summaryOf({ source: "first-open", withTree: false }) });
  await page.goto(`${baseURL}/sessions/${id}/changes`);
  await expect(
    page.getByText("Since this session was first viewed after the update"),
  ).toBeVisible();
  // one workspace needs no picker
  await expect(page.getByRole("combobox", { name: "Workspace" })).toHaveCount(0);
  await expect(page.getByText("Session directory · main · +3 −1")).toBeVisible();
});

test("a removed worktree reads the summary again and falls back", async ({ page }) => {
  const mock = await setup(page);
  await page.goto(`${baseURL}/sessions/${id}/changes`);
  await expect(appRegion(page)).toBeVisible();
  delete mock.diffs[tree];
  mock.summary = summaryOf({ withTree: false });
  const reads = mock.summaryReads;
  await page.getByRole("combobox", { name: "Workspace" }).selectOption(tree);
  await expect.poll(() => mock.summaryReads).toBeGreaterThan(reads);
  await expect(page.getByRole("combobox", { name: "Workspace" })).toHaveCount(0);
  await expect(page.getByText("Session directory · main · +3 −1")).toBeVisible();
  await expect(appRegion(page)).toBeVisible();
  expect(mock.diffReads).toContain(tree);
  await expect(changesTab(page)).toHaveAccessibleName("Changes, 2 changed files");
});

test("an edit that keeps the counts reads the diff again", async ({ page, liveStub }) => {
  const mock = await setup(page);
  await page.goto(`${baseURL}/sessions/${id}/changes`);
  await expect(appRegion(page).getByText("start(port);")).toBeVisible();
  mock.diffs[""] = [appFile(), { ...notesFile, rows: [...notesFile.rows] }];
  mock.diffs[""][1].rows[2] = row("add", "Read the port from the env.", 0, 2);
  mock.summary = summaryOf({ fingerprint: "f1" });
  await liveStub.reread(`session.changes:${id}`);
  await expect(page.getByText("Read the port from the env.")).toBeVisible();
  expect(mock.diffReads).toEqual(["", ""]);
});

test("a failed refresh keeps the diff and its draft beside the error", async ({
  page,
  liveStub,
}) => {
  const mock = await setup(page);
  await page.goto(`${baseURL}/sessions/${id}/changes`);
  await appRegion(page).getByText("start(port);").click();
  await page.getByRole("button", { name: "Comment on line 3" }).click();
  await page.getByLabel("Comment (Markdown)").fill("Keep me");
  mock.diffFails = true;
  mock.summary = summaryOf({ fingerprint: "f1" });
  await liveStub.reread(`session.changes:${id}`);
  await expect(page.getByText("Git is busy.")).toBeVisible();
  await expect(appRegion(page).getByText("start(port);")).toBeVisible();
  await expect(page.getByLabel("Comment (Markdown)")).toHaveValue("Keep me");
  // the next read clears the error
  mock.diffFails = false;
  mock.summary = summaryOf({ fingerprint: "f2" });
  await liveStub.reread(`session.changes:${id}`);
  await expect(page.getByText("Git is busy.")).toHaveCount(0);
  await expect(page.getByLabel("Comment (Markdown)")).toHaveValue("Keep me");
});

test("a login session follows no changes", async ({ page }) => {
  const mock = await setup(page, { session: { purpose: "login" } });
  await page.goto(`${baseURL}/sessions/${id}`);
  await expect(changesTab(page)).toHaveText("Changes");
  await changesTab(page).click();
  await expect(
    page.getByText("This session's folder is not a Git repository."),
  ).toBeVisible();
  expect(mock.summaryReads).toBe(0);
  expect(mock.diffReads).toEqual([]);
});

test("a plain folder shows a note and no badge", async ({ page }) => {
  const mock = await setup(page, {
    summary: { repository: false, startCommit: null, workspaces: [], changedFiles: 0 },
  });
  await page.goto(`${baseURL}/sessions/${id}`);
  await expect(changesTab(page)).toHaveText("Changes");
  await expect(changesTab(page).locator(".badge")).toHaveCount(0);
  await changesTab(page).click();
  await expect(
    page.getByText("This session's folder is not a Git repository."),
  ).toBeVisible();
  expect(mock.diffReads).toEqual([]);
});

test("a second Save during a create after a refresh creates one comment", async ({
  page,
  liveStub,
}) => {
  const mock = await setup(page);
  await page.goto(`${baseURL}/sessions/${id}/changes`);
  const region = appRegion(page);
  await region.getByText("start(port);").click();
  await page.getByRole("button", { name: "Comment on line 3" }).click();
  await page.getByLabel("Comment (Markdown)").fill("Read the port once");
  let release;
  mock.hold = new Promise((resolve) => (release = resolve));
  const save = page.getByRole("button", { name: "Save" });
  await save.click();
  await expect.poll(() => mock.creates.length).toBe(1);

  // The agent adds a line above: the summary changes, the diff is read again and the
  // editor moves to the shifted row (a remount).
  mock.diffs[""] = [appFile([row("add", "// port from the environment", 0, 1)])];
  mock.summary = summaryOf({ extra: 1 });
  await liveStub.reread(`session.changes:${id}`);
  await expect(region.getByText("// port from the environment")).toBeVisible();
  await expect(page.getByLabel("Comment (Markdown)")).toHaveValue("Read the port once");
  await expect(page.getByRole("button", { name: "Saving …" })).toBeDisabled();
  await page.getByRole("button", { name: "Saving …" }).click({ force: true });
  release();
  await expect(page.getByLabel("Comment (Markdown)")).toHaveCount(0);
  await expect(region.getByText("Read the port once")).toBeVisible();
  expect(mock.creates).toHaveLength(1);
  expect(mock.creates[0]).toMatchObject({ workspace: "", file: "src/app.js" });
});

// Two open comments, one per workspace, anchored on rows of the mocked diffs.
const openComments = () => [
  {
    id: "c-app",
    workspace: "",
    file: "src/app.js",
    anchor: {
      side: "new",
      line: 3,
      text: "start(port);",
      before: ["const port = Number(process.env.PORT) || 8080;"],
      after: ["export default start;"],
      excerpt: [{ kind: "add", text: "start(port);" }],
    },
    body: "Read the port once",
    status: "open",
    createdAt: stamp,
    updatedAt: stamp,
    sentIn: null,
  },
  {
    id: "c-readme",
    workspace: tree,
    file: "README.md",
    anchor: {
      side: "new",
      line: 1,
      text: "# Feature X",
      before: [],
      after: [],
      excerpt: [{ kind: "add", text: "# Feature X" }],
    },
    body: "Name the feature",
    status: "open",
    createdAt: stamp,
    updatedAt: stamp,
    sentIn: null,
  },
];
const coding = { tool: "codex", accountId: "local-codex" };
const sendButton = (page) => page.getByRole("button", { name: /^Send to agent/ });
const composer = (page) => page.getByRole("textbox", { name: "Message" });

test("Send to agent appends the batch to the chat composer", async ({
  page,
  liveStub,
}) => {
  const mock = await setup(page, { session: coding, comments: openComments() });
  await page.goto(`${baseURL}/sessions/${id}/chat`);
  await composer(page).fill("Keep the tests green");
  await changesTab(page).click();
  await expect(appRegion(page)).toBeVisible();
  await expect(sendButton(page)).toHaveText("Send to agent (2)");
  await sendButton(page).click();

  await expect(page).toHaveURL(new RegExp(`/sessions/${id}/chat$`));
  const tabs = page.locator(".terminal-topbar .segmented");
  await expect(tabs.getByRole("button", { name: "Chat" })).toHaveClass(/selected/);
  // a written draft keeps its text and gets the batch on a new line; nothing is sent
  await expect(composer(page)).toHaveValue(
    /^Keep the tests green\nReview notes \(2\):[\s\S]*1\. src\/app\.js:3[\s\S]*2\. \.worktrees\/feat\/x\/README\.md:1/,
  );
  expect(mock.sent).toEqual([["c-app", "c-readme"]]);
  expect(mock.diffReads.filter((w) => w === "")).toHaveLength(1);
  expect(mock.diffReads).toContain(tree);

  await liveStub.reread(`session.review:${id}`);
  await changesTab(page).click();
  await expect(appRegion(page).getByText("Sent in batch 1")).toBeVisible();
});

test("a failed sent marking stays on the tab with its error", async ({ page }) => {
  const mock = await setup(page, { session: coding, comments: openComments() });
  mock.markFails = true;
  await page.goto(`${baseURL}/sessions/${id}/changes`);
  await sendButton(page).click();
  await expect(page.getByText("Marking failed.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/sessions/${id}/changes$`));
  await expect(changesTab(page)).toHaveClass(/selected/);
});

test("a blank composer takes the batch as it is", async ({ page }) => {
  await setup(page, { session: coding, comments: openComments().slice(0, 1) });
  await page.goto(`${baseURL}/sessions/${id}/changes`);
  await expect(sendButton(page)).toHaveText("Send to agent (1)");
  await sendButton(page).click();
  await expect(composer(page)).toHaveValue(/^Review notes \(1\):/);
});

test("a draft and batch over 32,000 characters are refused", async ({ page }) => {
  const mock = await setup(page, { session: coding, comments: openComments() });
  await page.goto(`${baseURL}/sessions/${id}/chat`);
  const long = "x".repeat(31900);
  await composer(page).fill(long);
  await changesTab(page).click();
  await sendButton(page).click();
  await expect(page.getByRole("status").filter({ hasText: "32,000" })).toHaveText(
    /longer than 32,000 characters/,
  );
  await expect(page).toHaveURL(new RegExp(`/sessions/${id}/changes$`));
  expect(mock.sent).toEqual([]);
  await page
    .locator(".terminal-topbar .segmented")
    .getByRole("button", { name: "Chat" })
    .click();
  await expect(composer(page)).toHaveValue(long);
});

test("a terminal-only session copies the batch", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const mock = await setup(page, { comments: openComments() });
  await page.goto(`${baseURL}/sessions/${id}/changes`);
  await sendButton(page).click();
  await expect(page.getByRole("status").filter({ hasText: "clipboard" })).toHaveText(
    "This session has no chat. The review notes were copied to the clipboard.",
  );
  expect(mock.sent).toEqual([["c-app", "c-readme"]]);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /^Review notes \(2\):/,
  );
  await expect(page).toHaveURL(new RegExp(`/sessions/${id}/changes$`));
});

test("a refused clipboard shows the batch in a dialog", async ({ page }) => {
  const mock = await setup(page, { comments: openComments() });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("refused")) },
    });
  });
  await page.goto(`${baseURL}/sessions/${id}/changes`);
  await sendButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Review notes" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("pre")).toHaveText(/^Review notes \(2\):/);
  expect(mock.sent).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the tab keeps the page within the screen width", async ({ page }) => {
    await setup(page);
    await page.goto(`${baseURL}/sessions/${id}/changes`);
    await expect(appRegion(page).locator(".diff-row").first()).toBeVisible();
    await expect(page.getByText("Since the session started")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Send to agent/ })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    if (shots) await page.screenshot({ path: `${shots}/changes-tab-en-phone.png` });
  });
});
