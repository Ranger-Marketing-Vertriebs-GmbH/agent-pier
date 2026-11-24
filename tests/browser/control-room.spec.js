import fs from "node:fs/promises";
import path from "node:path";
import { scanFolderProcesses } from "../../server/features/projects/folder-processes.js";
import { test, expect } from "../helpers/browser-test.js";
import { controlRoomFixture, plan } from "./autopilot-fixture.js";

// Real live channel: the owned server publishes Composer writes and session requests.
test.use({ live: "real", locale: "en-GB" });

async function withinViewport(page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize().width);
}

test("two orders keep their own sessions, decisions, batch plan and run history", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(10000);
  const cleanups = [];
  try {
    const f = await controlRoomFixture(page, cleanups);
    const original = await f.create(
      "Migrate import jobs",
      "Move the nightly imports to the new storage engine.",
      "migration",
    );
    const overview = f.url + "/control-room";
    await page.goto(f.url + "/inbox");
    const room = page.getByRole("link", { name: "Control Room", exact: true });
    await page.getByRole("button", { name: "Inbox", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(room).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(overview);
    await page.getByRole("button", { name: "New order" }).click();
    const form = page.getByRole("dialog");
    await form
      .getByLabel("Order title", { exact: true })
      .fill("Validate export archives");
    await form
      .getByLabel("Brief", { exact: true })
      .fill("Check archive checksums after export.");
    const merge = form.getByRole("switch", { name: /autopilot may merge/i });
    await expect(merge).not.toBeChecked();
    await form.getByRole("button", { name: "Start order" }).click();
    await expect(page).toHaveURL(/\/sessions\/[^/]+\/chat$/);
    const { orders } = await f.application.autopilot.orders.list();
    const second = orders.find((o) => o.title === "Validate export archives");
    expect(page.url()).toBe(f.url + second.session.link);
    expect(second.session.id).not.toBe(original.session.id);
    expect(second.projectId).toBe(original.projectId);
    expect(f.application.pipelines.store.all()).toHaveLength(0);

    await page.goto(overview);
    await page.getByRole("link", { name: /Migrate import jobs/ }).click();
    const url = page.url();
    await expect(page.getByRole("heading", { name: original.title })).toBeVisible();
    await page.getByRole("button", { name: "Edit permissions" }).click();
    const policy = page.getByRole("switch", { name: /autopilot may merge/i });
    await policy.click();
    await expect(policy).toBeChecked();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect
      .poll(
        async () => (await f.application.autopilot.orders.get(original.id)).allowMerge,
      )
      .toBe(true);
    expect((await f.application.autopilot.orders.get(second.id)).allowMerge).toBe(false);
    await page.getByRole("button", { name: /^pause/i }).click();
    await expect
      .poll(
        async () => (await f.application.autopilot.orders.get(original.id)).manualPaused,
      )
      .toBe(true);
    await page.getByRole("button", { name: /^resume/i }).click();
    await expect
      .poll(
        async () => (await f.application.autopilot.orders.get(original.id)).manualPaused,
      )
      .toBe(false);
    expect((await f.application.autopilot.orders.get(original.id)).session.id).toBe(
      original.session.id,
    );

    f.progress(original, { draftBatches: plan, checkpoint: "Schema mapping recorded." });
    await expect(
      page.getByText("Schema mapping recorded.", { exact: true }),
    ).toBeVisible();
    const checked = f.run("mapping-check", "Mapping checks", "completed");
    const gate = f.run("import-review", "Importer rollout", "awaiting-human");
    f.progress(original, {
      draftBatches: [],
      batches: plan,
      status: "active",
      planStatus: "approved",
      checkpoint: "Schema mapping verified.",
      nextAction: "Review the importer rollout.",
      runs: [checked.id, gate.id],
      pullRequests: [
        {
          source: "github",
          url: "https://github.com/atlas/importer/pull/48",
          status: "open",
        },
      ],
      findings: [
        {
          title: "Missing checksum coverage",
          detail: "Two archive formats still need tests.",
          severity: "medium",
          url: "https://github.com/atlas/importer/issues/42",
        },
      ],
    });
    await expect(
      page.getByText("Schema mapping verified.", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("Review the importer rollout.", { exact: true }),
    ).toBeVisible();
    await page.getByText("Order brief", { exact: true }).click();
    await expect(page.getByText(original.brief, { exact: true })).toBeVisible();
    await page.getByText("Order brief", { exact: true }).click();
    const batch = page.getByRole("button", { name: /Prepare import storage/ });
    await batch.focus();
    await expect(batch).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Map legacy fields", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.locator('a[href="https://github.com/atlas/importer/issues/42"]').first(),
    ).toBeVisible();
    await expect(page.locator('a[href$="/pull/48"]').first()).toBeVisible();
    await expect(
      page.locator('a[href="/pipelines/runs/mapping-check"]').first(),
    ).toBeVisible();
    await withinViewport(page);
    await page.getByRole("heading", { name: original.title }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("control-room-wide.png") });

    const replies = await f.question(original.session.id);
    await page.getByRole("link", { name: /Storage decision/ }).click();
    await expect(page).toHaveURL(f.url + original.session.link);
    await page.getByLabel("SQLite", { exact: true }).check();
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await expect.poll(() => replies).toEqual([{ answers: { engine: ["sqlite"] } }]);
    await page.goto(url);
    await page.getByRole("link", { name: /Migration review/ }).click();
    await expect(page).toHaveURL(/\/pipelines\/runs\/import-review$/);
    await expect(
      page.getByText("Verify the importer against the saved migration plan.").first(),
    ).toBeVisible();

    f.progress(second, {
      status: "active",
      checkpoint: "Archive samples collected.",
      nextAction: "Compare checksums from the nightly exports.",
    });
    await page.goto(overview);
    await expect(
      page
        .getByRole("region", { name: /Waiting/ })
        .getByRole("link", { name: /Migrate import jobs/ }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: /Active/ })
        .getByRole("link", { name: /Validate export archives/ }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("control-room-overview.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("link", { name: /Migrate import jobs/ }).click();
    await expect(page.getByRole("heading", { name: original.title })).toBeVisible();
    await withinViewport(page);
    const ticket = page.getByRole("link", { name: /atlas\/importer#42/ });
    const status = await ticket.getByText("Closed", { exact: true }).boundingBox();
    const card = await ticket.locator("..").boundingBox();
    expect(status.x + status.width).toBeLessThanOrEqual(card.x + card.width);
    await page.screenshot({
      path: testInfo.outputPath("control-room-compact.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: /Roll out the new importer/ }).click();
    await expect(
      page.getByText("Verify migration coverage", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Depends on", { exact: true })).toBeVisible();
    await withinViewport(page);
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});

test("completed order cleanup can be retried and stays removed after refresh", async ({
  page,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const cleanups = [];
  try {
    const f = await controlRoomFixture(page, cleanups);
    const order = await f.create(
      "Archive import logs",
      "Archive completed import logs.",
      "archive",
    );
    const other = await f.create(
      "Keep export history",
      "Keep records for audit.",
      "keep",
    );
    f.progress(order, { status: "completed", checkpoint: "Archive verified." });
    await page.goto(f.url + "/control-room/" + order.id);
    await page.getByRole("button", { name: /remove order/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(/worktree/i);
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await dialog.getByLabel("Enter the order title to confirm").fill(order.title);
    await dialog.getByRole("button", { name: /remove/i }).click();
    await expect(dialog.getByRole("alert")).toContainText(/Stop active sessions/i);
    expect((await f.application.autopilot.orders.get(order.id)).id).toBe(order.id);
    await f.application.sessions.stop(order.session.id);
    // Stopping the session closes its pane first. Wait for its native helpers
    // to release their working directories before retrying the cleanup.
    await expect
      .poll(() => scanFolderProcesses([order.worktree]), { timeout: 20000 })
      .toEqual({ status: "ok", processes: [] });
    await page.reload();
    await page.getByRole("button", { name: /remove order/i }).click();
    await dialog.getByLabel("Enter the order title to confirm").fill(order.title);
    const removal = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url() === f.url + "/api/autopilot/orders/" + order.id,
    );
    await dialog.getByRole("button", { name: /remove/i }).click();
    expect((await removal).status()).toBe(204);
    await expect(page).toHaveURL(f.url + "/control-room");
    await page.reload();
    await expect(page.getByRole("link", { name: new RegExp(other.title) })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(order.title) })).toHaveCount(
      0,
    );
    expect((await f.application.autopilot.orders.list()).orders.map((o) => o.id)).toEqual(
      [other.id],
    );
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});

test("discovering a historical order does not give its claimed session or worktree owner controls", async ({
  page,
}) => {
  const cleanups = [];
  try {
    const f = await controlRoomFixture(page, cleanups);
    const folder = path.join(f.repo, ".git", "agentpier-composer");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(
      path.join(folder, "handover.json"),
      JSON.stringify({
        title: "Import handover",
        brief: "Review the previous migration.",
        status: "completed",
        allowMerge: true,
        sessionId: "unverified",
        worktree: f.repo,
      }),
    );
    await page.goto(f.url + "/control-room");
    await page.getByRole("link", { name: /Import handover/ }).click();
    await expect(page.getByText("Resource ownership is unverified.")).toBeVisible();
    for (const name of ["Remove order", "Pause order", "Resume order", "Recover session"])
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open session" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit permissions" })).toBeVisible();
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});

test.describe("new order deep link", () => {
  test.use({ live: "manual" });

  test("a cold start waits for the workspace before choosing the Composer account", async ({
    page,
    liveStub,
  }) => {
    await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
    await page.route("**/api/autopilot/projects", (route) =>
      route.fulfill({ json: { projects: [{ id: "atlas", name: "Atlas" }] } }),
    );
    await page.goto("/control-room/new");
    await liveStub.waitForSubscribe("state");
    await expect(page.locator(".control-room h1")).toHaveText("Control Room");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    liveStub.push("state", {
      tools: [{ id: "codex", name: "Codex", installed: true }],
      accounts: [{ id: "local-codex", tool: "codex", name: "Codex", kind: "local" }],
      sessions: [],
      home: "/home/test",
    });
    const form = page.getByRole("dialog");
    await form.getByLabel("Order title", { exact: true }).fill("Check exports");
    await form.getByLabel("Brief", { exact: true }).fill("Review the migration.");
    await expect(form.getByRole("button", { name: "Open Composer" })).toBeEnabled();
  });
});
