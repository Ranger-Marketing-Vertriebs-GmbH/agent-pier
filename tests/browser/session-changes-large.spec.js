import { test, expect } from "../helpers/browser-test.js";
import { fixture, stamp } from "../helpers/repository-browser.js";
import { baseURL } from "../helpers/browser.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";

// A session whose Changes tab holds hundreds of files (a long session against its start
// commit): files past the open budget start collapsed, so the tab renders a bounded
// number of rows, opens within a bound on a phone, and a push that leaves the shown
// workspace alone neither reads nor renders the diff again.
test.use({ locale: "en-GB" });

const id = "large-changes";
const sha = (char) => char.repeat(40);
const shots = process.env.CHANGES_SCREENSHOTS;
const FILES = 300;
const LINES = 59;

const code = (file, line) =>
  `export const value${line} = compute("${file}", ${line}) + offset(${line});`;
const bigFile = (index) => {
  const path = `src/module-${String(index).padStart(3, "0")}.js`;
  return {
    path,
    oldPath: null,
    status: "added",
    binary: false,
    added: LINES,
    removed: 0,
    rows: [
      { kind: "meta", text: `@@ -0,0 +1,${LINES} @@` },
      ...Array.from({ length: LINES }, (_, i) => ({
        kind: "add",
        text: code(path, i + 1),
        newLine: i + 1,
      })),
    ],
    rowsTruncated: false,
  };
};
const files = Array.from({ length: FILES }, (_, i) => bigFile(i));
const last = files.at(-1).path;

const summaryOf = ({ fingerprint = "f0", other = 1 } = {}) => {
  const workspaces = [
    {
      id: "",
      branch: "main",
      base: { kind: "start-commit", sha: sha("a") },
      files: FILES,
      added: FILES * LINES,
      removed: 0,
      fingerprint,
    },
    {
      id: ".worktrees/other",
      branch: "other",
      base: { kind: "merge-base", sha: sha("b"), ref: "refs/remotes/origin/main" },
      files: 1,
      added: other,
      removed: 0,
      fingerprint: `o${other}`,
    },
  ];
  return {
    repository: true,
    startCommit: { sha: sha("a"), source: "start" },
    workspaces,
    changedFiles: FILES + 1,
  };
};

const commentOnLast = {
  id: "c-last",
  workspace: "",
  file: last,
  anchor: {
    side: "new",
    line: 2,
    text: code(last, 2),
    before: [code(last, 1)],
    after: [code(last, 3)],
    excerpt: [{ kind: "add", text: code(last, 2) }],
  },
  body: "Check the last module",
  status: "open",
  createdAt: stamp,
  updatedAt: stamp,
  sentIn: null,
};

async function setup(page, { comments = [], extra = [] } = {}) {
  const { state } = await fixture(page);
  state.sessions.push({
    id,
    name: "Large changes",
    tool: "shell",
    cwd: "/home/test/project",
    status: "running",
    accountId: "local-shell",
    createdAt: stamp,
  });
  const mock = { summary: summaryOf(), diffReads: 0 };
  const chat = { availability: "ready", messages: [], tasks: [] };
  await mockChatStream(page, () => chat);
  await page.route(`**/api/sessions/${id}/**`, async (route) => {
    const url = new URL(route.request().url());
    const rest = url.pathname.slice(`/api/sessions/${id}`.length);
    if (rest === "/changes") return route.fulfill({ json: mock.summary });
    if (rest === "/changes/diff") {
      mock.diffReads++;
      const base = mock.summary.workspaces[0].base;
      const all = [...files, ...extra];
      return route.fulfill({
        json: { workspace: "", base, files: all, truncated: true },
      });
    }
    if (rest === "/chat") return route.fulfill({ json: chat });
    if (rest === "/models")
      return route.fulfill({
        json: { currentModel: null, picker: null, pending: false },
      });
    if (rest === "/github")
      return route.fulfill({ json: { configured: true, hosts: [], remote: null } });
    if (rest === "/review-comments")
      return route.fulfill({ json: { comments, batches: 0 } });
    return route.fallback();
  });
  return mock;
}

const heading = (page, path) =>
  page.locator(".diff-file").filter({ has: page.getByText(path, { exact: true }) });
const toggle = (page, path) => heading(page, path).locator(".diff-file-toggle");

async function openTab(page) {
  await page.goto(`${baseURL}/sessions/${id}`);
  const tab = page
    .locator(".terminal-topbar .segmented")
    .getByRole("button", { name: /^Changes/ });
  await expect(tab).toBeVisible();
  const started = Date.now();
  await tab.click();
  await expect(page.locator(".diff-row").first()).toBeVisible();
  // the page answers again: one frame after the first rows
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
  return Date.now() - started;
}

for (const [name, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(`on a ${name}`, () => {
    test.use(use);

    test("a large diff opens with files past the budget collapsed", async ({ page }) => {
      await setup(page);
      const elapsed = await openTab(page);
      // a generous bound: before the fix this tab built ~20,000 rows at once
      expect(elapsed).toBeLessThan(8000);
      const rows = await page.locator(".diff-row").count();
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThanOrEqual(1200);
      // memory: a phone's WebView reloads (and reopens this tab) under memory pressure,
      // so the page stays a bounded DOM: 26,735 elements measured here for 20 open
      // files of 60 highlighted rows (the owner's real diff: 10,913, was 190,713)
      const elements = await page.evaluate(
        () => document.getElementsByTagName("*").length,
      );
      expect(elements).toBeLessThan(32000);
      await expect(page.locator(".diff-review-summary")).toHaveText(
        `${FILES} files · ${FILES - 20} collapsed`,
      );
      await expect(toggle(page, files[0].path)).toHaveAttribute("aria-expanded", "true");
      await expect(toggle(page, last)).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("region", { name: `Diff of ${last}` })).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(name === "phone" ? 390 : 1440);
      if (shots) await page.screenshot({ path: `${shots}/changes-large-${name}.png` });
      if (shots) {
        // where the open files end and the collapsed ones begin
        await page.evaluate((path) => {
          const file = [...document.querySelectorAll(".diff-file")].find((node) =>
            node.textContent.includes(path),
          );
          file?.scrollIntoView({ block: "center" });
        }, files[20].path);
        await page.screenshot({ path: `${shots}/changes-large-${name}-collapsed.png` });
      }

      // the file list opens a collapsed file and scrolls to it
      await page
        .getByRole("navigation", { name: "Changed files" })
        .getByRole("button", { name: new RegExp(last) })
        .click();
      const region = page.getByRole("region", { name: `Diff of ${last}` });
      await expect(region).toBeInViewport();
      await expect(toggle(page, last)).toHaveAttribute("aria-expanded", "true");
      // and its heading closes it again
      await toggle(page, last).click();
      await expect(region).toHaveCount(0);
      await toggle(page, files[0].path).click();
      await expect(
        page.getByRole("region", { name: `Diff of ${files[0].path}` }),
      ).toHaveCount(0);
    });
  });
}

test("a file with a comment opens wherever it is", async ({ page }) => {
  await setup(page, { comments: [commentOnLast] });
  await openTab(page);
  await expect(toggle(page, last)).toHaveAttribute("aria-expanded", "true");
  const region = page.getByRole("region", { name: `Diff of ${last}` });
  await expect(region.getByText("Check the last module")).toBeAttached();
  // closed by hand it names its comment in the heading
  await toggle(page, last).click();
  await expect(region).toHaveCount(0);
  await expect(heading(page, last).getByText("1 comment")).toBeVisible();
});

test("comments past the budget stay reachable from the list and the heading", async ({
  page,
}) => {
  // comments on 60 files, every one outdated: the second budget opens 20 of them
  const comments = files.slice(100, 160).map((file, i) => ({
    ...commentOnLast,
    id: `c${i}`,
    file: file.path,
    anchor: { ...commentOnLast.anchor, text: "a line that is gone" },
  }));
  await setup(page, { comments });
  await openTab(page);
  const shut = files[159].path;
  await expect(toggle(page, files[119].path)).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page, shut)).toHaveAttribute("aria-expanded", "false");
  await expect(heading(page, shut).getByText("1 comment")).toBeVisible();
  const link = page
    .getByRole("navigation", { name: "Changed files" })
    .getByRole("button", { name: new RegExp(shut) });
  await expect(link).toContainText("1 comment");
  await link.click();
  await expect(toggle(page, shut)).toHaveAttribute("aria-expanded", "true");
  await expect(heading(page, shut).getByText("Check the last module")).toBeVisible();
  expect(await page.locator(".diff-row").count()).toBeLessThanOrEqual(2600); // two budgets, the opened file, excerpts
});

test("the file list focuses a binary file's heading", async ({ page }) => {
  const binary = {
    ...bigFile(999),
    path: "assets/logo.png",
    binary: true,
    added: 0,
    rows: [],
  };
  await setup(page, { extra: [binary] });
  await openTab(page);
  await page
    .getByRole("navigation", { name: "Changed files" })
    .getByRole("button", { name: /assets\/logo\.png/ })
    .click();
  await expect(toggle(page, "assets/logo.png")).toBeFocused();
  await expect(heading(page, "assets/logo.png").getByText("Binary file")).toBeVisible();
});

test("a push for another workspace neither reads nor rebuilds the diff", async ({
  page,
  liveStub,
}) => {
  const mock = await setup(page);
  await openTab(page);
  // a file the reader opened stays open across pushes and reads
  await toggle(page, last).click();
  await expect(page.getByRole("region", { name: `Diff of ${last}` })).toBeVisible();
  await page.evaluate(() => {
    window.__rowsAdded = 0;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.nodeType === 1)
            window.__rowsAdded += node.matches(".diff-row")
              ? 1
              : node.querySelectorAll(".diff-row").length;
    }).observe(document.body, { childList: true, subtree: true });
  });
  mock.summary = summaryOf({ other: 2 });
  await liveStub.reread(`session.changes:${id}`);
  await expect(
    page.getByRole("combobox", { name: "Workspace" }).locator("option").nth(1),
  ).toHaveText(/\+2 −0/);
  expect(mock.diffReads).toBe(1);
  expect(await page.evaluate(() => window.__rowsAdded)).toBe(0);

  // a change in the shown workspace reads it again and keeps the reader's choice
  mock.summary = summaryOf({ fingerprint: "f1", other: 2 });
  await liveStub.reread(`session.changes:${id}`);
  await expect.poll(() => mock.diffReads).toBe(2);
  await expect(toggle(page, last)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("region", { name: `Diff of ${last}` })).toBeVisible();
});
