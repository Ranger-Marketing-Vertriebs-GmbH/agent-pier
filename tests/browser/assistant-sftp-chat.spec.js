import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setup } from "./assistant-shell-fixture.js";
import { setupAssistantSettings } from "../helpers/assistant-settings-browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { openChat } from "./assistant-ssh-fixture.js";

// The agent chat's SFTP card (SftpApprovalCard) and activity rows (SftpRunNote).
const sftpAction = (id, extra = {}) => ({
  id,
  revision: 1,
  assistantId: "home",
  state: "awaiting_approval",
  createdAt: "2026-10-23T10:00:00.000Z",
  expiresAt: "2026-10-23T10:10:00.000Z",
  ...extra,
  payload: {
    action: "sftp",
    trusted: false,
    operation: "upload",
    kind: "write",
    direction: "up",
    accessId: "33333333-3333-4333-8333-333333333333",
    hostName: "web-01",
    host: "web.invalid",
    port: 22,
    username: "deploy",
    hostFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789",
    projectId: null,
    projectName: null,
    remotePath: "/srv/www",
    local: { projectId: "p1", projectName: "Website", path: "dist" },
    summary: {
      files: 6,
      bytes: 3.5 * 1024 ** 2,
      overwrites: 1,
      create: ["index.html", "app.js", "style.css"],
      update: ["robots.txt"],
      delete: [],
      deleteDirs: [],
      more: { create: 2, update: 0, delete: 0 },
      moreDeleteDirs: 0,
    },
    deletes: 0,
    allowAlways: true,
    originClass: "owner",
    ...extra.payload,
  },
});
const deleteAction = (id) =>
  sftpAction(id, {
    payload: {
      operation: "delete",
      kind: "delete",
      direction: undefined,
      remotePath: "/srv/www/old",
      local: undefined,
      summary: {
        path: "/srv/www/old",
        recursive: true,
        files: 3,
        dirs: 1,
        bytes: 2048,
        overwrites: 0,
        create: [],
        update: [],
        delete: ["/srv/www/old/a.html", "/srv/www/old/b.html", "/srv/www/old/c.css"],
        deleteDirs: ["/srv/www/old"],
        more: { create: 0, update: 0, delete: 0 },
        moreDeleteDirs: 0,
      },
      deletes: 4,
      allowAlways: false,
    },
  });
const sftpCard = (page) => page.getByRole("article", { name: "SFTP operation" });

const note = (id, extra = {}) => ({
  id: `sftp-run:${id}`,
  role: "event",
  event: "sftp-run",
  hostName: "web-01",
  operation: "upload",
  direction: "up",
  remotePath: "/srv/www",
  toPath: null,
  localPath: "dist",
  localProject: "Website",
  state: "completed",
  progress: null,
  result: {
    state: "completed",
    files: 124,
    bytes: 3.5 * 1024 ** 2,
    created: 120,
    updated: 4,
    deleted: 0,
    overwrites: 4,
    durationMs: 3400,
  },
  timestamp: 1760608800000 + id.length,
  runId: null,
  ...extra,
});
// The routed history; `push()` hands its current value to the chat's feed.
async function withMessages(page, initial) {
  const history = { messages: initial };
  await page.route(/\/messages(\?|$)/, (route) =>
    route.fulfill({ json: { messages: history.messages, requests: [], stale: false } }),
  );
  return {
    history,
    push: () => page.evaluate(() => window.agentFeed.push("chat")),
  };
}

test("card shows summary and three buttons", async ({ page }) => {
  const state = await setup(page, { actions: [sftpAction("s1")] });
  await openChat(page);
  const card = sftpCard(page);
  await expect(card).toContainText("Upload");
  await expect(card).toContainText("deploy@web.invalid:22");
  await expect(card).toContainText("SHA256:abcdefghijkl");
  await expect(card).toContainText("/srv/www");
  await expect(card).toContainText("Website · dist");
  await expect(card).toContainText("5 new · 1 changed · 0 deleted");
  await expect(card).toContainText("3.5 MB");
  await expect(card.getByRole("status")).toHaveAttribute("aria-live", "polite");
  const buttons = card.locator(".assistant-card-actions").getByRole("button");
  await expect(buttons).toHaveText(["Allow once", "Always allow for this host", "Deny"]);
  // The paths wait behind a disclosure; cut lists say how many more there are.
  const toggle = card.getByRole("button", { name: "Show paths" });
  await expect(card.locator("[data-list=create]")).toBeHidden();
  await toggle.click();
  await expect(card.getByRole("button", { name: "Hide paths" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(card.locator("[data-list=create] pre")).toHaveText(
    "index.html\napp.js\nstyle.css",
  );
  await expect(card.locator("[data-list=create]")).toContainText("+2 more");
  await expect(card.locator("[data-list=update]")).toContainText("robots.txt");
  await card.getByRole("button", { name: "Always allow for this host" }).click();
  await expect
    .poll(() => state.decisions)
    .toEqual([["s1", { revision: 1, decision: "allow-always" }]]);
});

test("Allow once and Deny send their decisions", async ({ page }) => {
  const state = await setup(page, {
    actions: [sftpAction("s1"), sftpAction("s2", { payload: { hostName: "web-02" } })],
  });
  await openChat(page);
  await sftpCard(page).first().getByRole("button", { name: "Allow once" }).click();
  await sftpCard(page).first().getByRole("button", { name: "Deny" }).click();
  await expect
    .poll(() => state.decisions)
    .toEqual([
      ["s1", { revision: 1, decision: "approve" }],
      ["s2", { revision: 1, decision: "decline" }],
    ]);
});

test("delete card has no Always allow", async ({ page }) => {
  await setup(page, {
    actions: [
      deleteAction("d1"),
      // A temporary member's card uses its lead's grant: no Always allow either.
      sftpAction("m1", { payload: { allowAlways: false, hostName: "web-02" } }),
    ],
  });
  await openChat(page);
  const [del, member] = [sftpCard(page).first(), sftpCard(page).nth(1)];
  await expect(del).toContainText("Delete");
  await expect(del).toContainText("0 new · 0 changed · 4 deleted");
  await expect(del.locator("[data-deletes]")).toHaveText(
    "Deletes 4 entries on the server. Deletes always ask.",
  );
  for (const card of [del, member]) {
    await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Deny" })).toBeVisible();
    await expect(card.getByRole("button", { name: /Always allow/ })).toHaveCount(0);
  }
  await del.getByRole("button", { name: "Show paths" }).click();
  await expect(del.locator("[data-list=delete][data-delete]")).toContainText(
    "/srv/www/old/c.css",
  );
  await expect(del.locator("[data-list=deleteDirs][data-delete]")).toContainText(
    "Deleted folders",
  );
});

test("an allowed card shows its progress without buttons", async ({ page }) => {
  await setup(page, {
    actions: [
      sftpAction("s1", {
        state: "executing",
        revision: 2,
        progress: { files: 6, filesDone: 3, bytes: 1000, bytesDone: 500 },
      }),
    ],
  });
  await openChat(page);
  const card = sftpCard(page);
  await expect(card.getByRole("status")).toContainText("50 % · 3 of 6 files");
  await expect(card.getByRole("button", { name: /Allow once|Deny/ })).toHaveCount(0);
});

test("running row updates its progress and ends done", async ({ page }) => {
  await setup(page);
  const progress = (filesDone, bytesDone) => ({
    files: 124,
    filesDone,
    bytes: 1000,
    bytesDone,
    current: "assets/app.js",
  });
  const feed = await withMessages(page, [
    note("r1", { state: "executing", result: null, progress: progress(12, 425) }),
  ]);
  await openChat(page);
  const row = page.locator("[data-sftp-run]");
  await expect(row).toHaveAttribute("data-sftp-run", "executing");
  await expect(row.getByRole("button")).toHaveText(
    /Upload to web-01\s*\/srv\/www\s*42 % · 12 of 124 files/,
  );
  feed.history.messages = [
    note("r1", { state: "executing", result: null, progress: progress(100, 810) }),
  ];
  await feed.push();
  await expect(row.getByRole("button")).toContainText("81 % · 100 of 124 files");
  feed.history.messages = [note("r1")];
  await feed.push();
  await expect(row).toHaveAttribute("data-sftp-run", "completed");
  await expect(row.getByRole("button")).toContainText("Done");
  await expect(page.locator("[data-sftp-run]")).toHaveCount(1);
});

test("expanded row shows paths, bytes and duration", async ({ page }) => {
  await setup(page);
  await withMessages(page, [
    note("e1"),
    note("e22", {
      operation: "download",
      direction: "down",
      remotePath: "/var/backups",
      localPath: "backups",
      localProject: undefined,
      state: "failed",
      result: {
        state: "failed",
        files: 2,
        bytes: 4096,
        created: 2,
        updated: 0,
        deleted: 0,
        code: "SFTP_PERMISSION",
        failedPath: "/var/backups/db.sql",
        durationMs: 900,
      },
    }),
  ]);
  await openChat(page);
  // Consecutive SFTP jobs share one group row like SSH runs.
  const group = page.locator("[data-activity-group]");
  await expect(group.getByRole("button").first()).toContainText(
    /SFTP activity\s*2 calls · web-01\s*1 failed/,
  );
  await group.getByRole("button").first().click();
  const done = page.locator("[data-sftp-run=completed]");
  await done.getByRole("button", { name: /Upload to web-01/ }).click();
  const facts = done.locator(".activity-row-facts");
  await expect(facts).toContainText(/Path on the server\s*\/srv\/www/);
  await expect(facts).toContainText(/Local path\s*Website · dist/);
  await expect(facts).toContainText(/Files\s*120 new · 4 changed · 0 deleted/);
  await expect(facts).toContainText(/Size\s*3.5 MB/);
  await expect(facts).toContainText(/Duration\s*3.4 s/);
  const failed = page.locator("[data-sftp-run=failed]");
  await failed.getByRole("button", { name: /Download from web-01/ }).click();
  await expect(failed.locator(".activity-row-facts")).toContainText(
    /Local path\s*Workspace · backups/,
  );
  await expect(failed.locator(".activity-row-facts")).toContainText(
    /Error\s*Permission denied.\s*Failed at\s*\/var\/backups\/db.sql/,
  );
  const overflow = await page.evaluate(
    () => document.scrollingElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test("SFTP rows join a group with SSH runs", async ({ page }) => {
  await setup(page);
  await withMessages(page, [
    {
      id: "ssh-run:a",
      role: "event",
      event: "ssh-run",
      hostName: "web-01",
      commandPreview: "uptime",
      outcome: "done",
      durationMs: 100,
      timestamp: 1760608800000,
      runId: null,
    },
    note("b", { timestamp: 1760608800001 }),
  ]);
  await openChat(page);
  await expect(page.locator('[data-activity-group="2"]')).toContainText(
    /SSH activity\s*2 calls · web-01\s*Done/,
  );
});

test("Work tab history line", async ({ page }) => {
  await setupAssistantSettings(page, {
    actions: [
      {
        id: "h1",
        revision: 1,
        assistantId: "home",
        state: "completed",
        createdAt: "2026-10-23T10:00:00.000Z",
        payload: {
          action: "sftp",
          trusted: true,
          operation: "upload",
          direction: "up",
          hostName: "web-01",
          remotePath: "/srv/www",
        },
        result: { state: "completed", files: 124, bytes: 2048, durationMs: 1200 },
      },
      {
        id: "h2",
        revision: 2,
        assistantId: "home",
        state: "declined",
        createdAt: "2026-10-23T10:05:00.000Z",
        payload: {
          action: "sftp",
          trusted: false,
          operation: "delete",
          hostName: "web-01",
          remotePath: "/srv/www/old",
        },
      },
    ],
  });
  await page.goto(baseURL + settingsPath("work", "actions"));
  await expect(
    page.getByText("SFTP · Upload on web-01 · Done · 124 files · 2 kB · 1.2 s"),
  ).toBeVisible();
  await expect(page.getByText("Ran without asking")).toBeVisible();
  await expect(page.getByText("SFTP · Delete on web-01 · Denied")).toBeVisible();
});
