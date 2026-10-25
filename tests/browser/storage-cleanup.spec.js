import { test, expect } from "@playwright/test";
import { details, summary } from "../helpers/system-status-fixture.js";
import { systemStatusCopy as en } from "../../web/lib/i18n/en/system-status.js";
import { systemStatusCopy as de } from "../../web/lib/i18n/de/system-status.js";

const GB = 1024 ** 3;
const shots = process.env.AGENTPIER_SCREENSHOT_DIR;
const backups = () => ({
  blocked: false,
  snapshots: [
    {
      id: "9d2c3f1e-5a4b-4c3d-8e7f-0a1b2c3d4e5f",
      createdAt: "2026-10-20T10:00:00.000Z",
      previousVersion: "2026.10.3",
      targetVersion: "2026.10.7",
      committedAt: "2026-10-20T10:05:00.000Z",
      recovery: false,
      bytes: 6 * GB,
      partial: false,
      reason: null,
    },
    {
      id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      createdAt: "2026-09-01T10:00:00.000Z",
      previousVersion: "2026.9.8",
      targetVersion: "2026.10.3",
      committedAt: "2026-09-01T10:05:00.000Z",
      recovery: false,
      bytes: 5 * GB,
      partial: false,
      reason: null,
    },
  ],
});
const transcripts = {
  profiles: [
    {
      id: "p-claude",
      name: "Work",
      tool: "claude",
      cutoffs: [
        { days: 30, count: 41, bytes: 3 * GB, kept: 2 },
        { days: 90, count: 20, bytes: 2 * GB, kept: 2 },
        { days: 180, count: 0, bytes: 0, kept: 1 },
      ],
    },
    {
      id: "p-codex",
      name: "Codex Pro",
      tool: "codex",
      cutoffs: [
        { days: 30, count: 12, bytes: GB, kept: 0 },
        { days: 90, count: 3, bytes: 0.5 * GB, kept: 0 },
        { days: 180, count: 1, bytes: 0.1 * GB, kept: 0 },
      ],
    },
  ],
};
const dependencies = {
  agents: [
    {
      id: "a1",
      name: "Ada",
      folders: 3,
      bytes: 1.5 * GB,
      partial: false,
      working: false,
    },
    { id: "a2", name: "Ben", folders: 1, bytes: 0.4 * GB, partial: false, working: true },
  ],
};

async function routeAll(page) {
  const calls = { lists: 0, deleted: [] };
  let snapshots = backups();
  await page.route("**/api/system-status", (route) => route.fulfill({ json: summary() }));
  await page.route("**/api/system-status/details", (route) =>
    route.fulfill({ json: details() }),
  );
  await page.route("**/api/system-status/cleanup/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === "GET") calls.lists++;
    if (method !== "GET")
      calls.deleted.push({ method, path: url.pathname, body: request.postDataJSON() });
    if (url.pathname.endsWith("/update-backups"))
      return route.fulfill({ json: snapshots });
    if (url.pathname.endsWith("/transcripts"))
      return route.fulfill({ json: transcripts });
    if (url.pathname.endsWith("/dependencies"))
      return route.fulfill({ json: dependencies });
    if (url.pathname.includes("/update-backups/")) {
      snapshots = { ...snapshots, snapshots: snapshots.snapshots.slice(0, 1) };
      return route.fulfill({ json: { removed: 1, bytes: 5 * GB } });
    }
    if (url.pathname.includes("/dependencies/"))
      return route.fulfill({
        status: 409,
        json: { error: "The agent is working or a command runs in its workspace." },
      });
    return route.fulfill({ json: { removed: 3, bytes: 0.5 * GB, skipped: 2 } });
  });
  return calls;
}
async function openDetails(page) {
  await page.goto("/");
  await page.getByRole("button", { name: /System status|Systemstatus/ }).click();
  return page.getByRole("dialog", { name: /System status|Systemstatus/ });
}

test.describe("in English", () => {
  test.use({ locale: "en-GB" });

  test("update backups are measured on request and deleted after a confirmation", async ({
    page,
  }) => {
    const calls = await routeAll(page);
    const dialog = await openDetails(page);
    await expect(dialog.getByRole("heading", { name: en.cleanup.heading })).toBeVisible();
    // Opening the details measures nothing; the poll never asks for cleanup sizes.
    await page.waitForTimeout(500);
    expect(calls.lists).toBe(0);
    const open = dialog.getByRole("button", {
      name: `${en.cleanup.snapshots.title}: ${en.cleanup.open}`,
    });
    await open.click();
    await expect(open).toHaveAttribute("aria-expanded", "true");
    const list = dialog.getByRole("group", { name: en.cleanup.snapshots.label });
    await expect(list).toContainText("Update 2026.10.3 → 2026.10.7");
    await expect(list).toContainText("6 GB");
    if (shots) {
      await list.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/update-backups.png` });
    }
    await list
      .getByRole("button", { name: /Delete the update backup from/ })
      .last()
      .click();
    const confirm = page.getByRole("dialog", { name: /Delete the update backup from/ });
    await expect(confirm).toContainText("This frees 5 GB.");
    await expect(confirm).toContainText(
      "The way back to the previous agent runtime (2026.9.8) goes away",
    );
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    if (shots) await page.screenshot({ path: `${shots}/update-backup-confirm.png` });
    await confirm.getByRole("button", { name: en.cleanup.snapshots.confirm }).click();
    await expect(confirm).toHaveCount(0);
    await expect(dialog.getByText("Deleted. 5 GB freed.")).toBeVisible();
    await expect(
      list.getByRole("button", { name: /Delete the update backup/ }),
    ).toHaveCount(1);
    expect(calls.deleted).toEqual([
      {
        method: "DELETE",
        path: "/api/system-status/cleanup/update-backups/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        body: null,
      },
    ]);
  });

  test("transcripts are deleted per profile for the chosen age", async ({ page }) => {
    const calls = await routeAll(page);
    const dialog = await openDetails(page);
    await dialog
      .getByRole("button", {
        name: `${en.cleanup.transcripts.title}: ${en.cleanup.open}`,
      })
      .click();
    const list = dialog.getByRole("group", { name: en.cleanup.transcripts.label });
    await expect(list).toContainText("20 transcripts · 2 GB");
    await expect(list).toContainText("2 more stay: AgentPier still lists their sessions");
    await dialog.getByRole("radio", { name: "180 days ago" }).check();
    await expect(list).toContainText("Nothing that old");
    await expect(
      list.getByRole("button", { name: "Delete old transcripts of Work" }),
    ).toBeDisabled();
    await dialog.getByRole("radio", { name: "90 days ago" }).check();
    if (shots) {
      await list.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/transcripts.png` });
    }
    await list
      .getByRole("button", { name: "Delete old transcripts of Codex Pro" })
      .click();
    const confirm = page.getByRole("dialog", {
      name: 'Delete transcripts of "Codex Pro" older than 90 days?',
    });
    await expect(confirm).toContainText("can no longer be resumed");
    await expect(confirm).toContainText(en.cleanup.transcripts.codexNote);
    if (shots) await page.screenshot({ path: `${shots}/transcripts-confirm.png` });
    await confirm.getByRole("button", { name: en.cleanup.transcripts.confirm }).click();
    await expect(confirm).toHaveCount(0);
    await expect(
      dialog.getByText(
        "Deleted. 512 MB freed. 2 entries stayed: they changed meanwhile or are in use.",
      ),
    ).toBeVisible();
    expect(calls.deleted).toEqual([
      {
        method: "POST",
        path: "/api/system-status/cleanup/transcripts/p-codex",
        body: { olderThanDays: 90 },
      },
    ]);
  });

  test("a working agent's dependencies wait; a refusal stays in the dialog", async ({
    page,
  }) => {
    await routeAll(page);
    const dialog = await openDetails(page);
    await dialog
      .getByRole("button", {
        name: `${en.cleanup.dependencies.title}: ${en.cleanup.open}`,
      })
      .click();
    const list = dialog.getByRole("group", { name: en.cleanup.dependencies.label });
    await expect(list).toContainText("3 node_modules folders");
    await expect(list).toContainText(en.cleanup.dependencies.working);
    await expect(
      list.getByRole("button", { name: "Delete installed dependencies of Ben" }),
    ).toBeDisabled();
    if (shots) {
      await list.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/dependencies.png` });
    }
    await list
      .getByRole("button", { name: "Delete installed dependencies of Ada" })
      .click();
    const confirm = page.getByRole("dialog", {
      name: 'Delete installed dependencies of "Ada"?',
    });
    await expect(confirm).toContainText("This deletes 3 node_modules folders");
    await confirm.getByRole("button", { name: en.cleanup.dependencies.confirm }).click();
    await expect(confirm.getByRole("alert")).toContainText("The agent is working");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
  });
});

test("the cleanup speaks German with the German catalog", async ({ page }) => {
  await routeAll(page);
  const dialog = await openDetails(page);
  await expect(dialog.getByRole("heading", { name: de.cleanup.heading })).toBeVisible();
  await dialog
    .getByRole("button", { name: `${de.cleanup.snapshots.title}: ${de.cleanup.open}` })
    .click();
  const list = dialog.getByRole("group", { name: de.cleanup.snapshots.label });
  await list
    .getByRole("button", { name: /Update-Sicherung vom .* löschen/ })
    .first()
    .click();
  const confirm = page.getByRole("dialog", { name: /Update-Sicherung vom .* löschen\?/ });
  await expect(confirm).toContainText("Der Weg zurück zur vorherigen Agenten-Laufzeit");
  await expect(
    confirm.getByRole("button", { name: de.cleanup.snapshots.confirm }),
  ).toBeVisible();
});
