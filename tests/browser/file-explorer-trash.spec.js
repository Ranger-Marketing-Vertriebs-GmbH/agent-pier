import { actionsFixture, trashEntry } from "../helpers/file-actions-browser.js";
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { explorerFixture, selectEnglish } from "../helpers/file-explorer-browser.js";

test("trash panel exposes restore and frozen permanent-delete consent", async ({
  page,
}) => {
  await explorerFixture(page);
  await page.route("**/api/files/trash", (route) =>
    route.fulfill({
      json: {
        entries: [
          {
            id: "trash-one",
            originalPath: "/home/test/report.txt",
            type: "file",
            size: 12,
            deletedAt: "2026-09-13T10:00:00Z",
            reason: "deleted",
            availability: "recoverable",
            revision: `t1:${"a".repeat(64)}`,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await selectEnglish(page);
  await page.goto(baseURL + "/files?panel=trash");
  await page.getByRole("checkbox", { name: "Select report.txt", exact: true }).check();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("/home/test/report.txt");
});

test("restore preserves a colliding original until Keep both is decided", async ({
  page,
  browserName,
}) => {
  const f = await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files?panel=trash");
  await page.getByRole("checkbox", { name: "Select report.txt", exact: true }).check();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "File conflict", exact: true }),
  ).toBeVisible();
  expect(f.trash).toHaveLength(1);
  await page.screenshot({
    path: `.superpowers/sdd/2026-09-13-file-explorer/screenshots/${browserName}-task12-en-restore-conflict.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Keep both", exact: true }).click();
  await expect(page.getByRole("region", { name: "File jobs" })).toContainText(
    "report (2).txt",
  );
  expect(f.trash).toHaveLength(0);
  expect(f.unknown).toEqual([]);
});

test("missing original parent requires a deliberate target without creating folders", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  f.trash[0].originalPath = "/missing/report.txt";
  f.missingParents.add("/missing");
  await selectEnglish(page);
  await page.goto(baseURL + "/files?panel=trash");
  await page.getByRole("checkbox", { name: "Select report.txt", exact: true }).check();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Choose restore destination",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect(f.requests.filter((request) => request.suffix === "/operations")).toHaveLength(
    0,
  );
  await dialog
    .getByRole("textbox", { name: "Path", exact: true })
    .fill("/home/test/restored.txt");
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  await expect
    .poll(() => f.requests.filter((request) => request.suffix === "/operations").length)
    .toBe(1);
  expect(f.requests.find((request) => request.suffix === "/operations").body.target).toBe(
    "/home/test/restored.txt",
  );
  expect(f.requests.some((request) => request.body?.kind === "create_directory")).toBe(
    false,
  );
});

test("restore destination keeps native selection and Trash selection ownership", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  f.trash.push(trashEntry("second"));
  f.trash[0].originalPath = "/missing/report.txt";
  f.missingParents.add("/missing");
  await selectEnglish(page);
  await page.goto(baseURL + "/files?panel=trash");
  const report = page.getByRole("checkbox", { name: "Select report.txt", exact: true });
  const second = page.getByRole("checkbox", { name: "Select second.txt", exact: true });
  await report.check();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  const target = page
    .getByRole("dialog", { name: "Choose restore destination", exact: true })
    .getByRole("textbox", { name: "Path", exact: true });
  await target.fill("/home/test/new.txt");
  await target.press("ControlOrMeta+a");
  await target.pressSequentially("X");
  await expect(target).toHaveValue("X");
  await expect(report).toBeChecked();
  await expect(second).not.toBeChecked();
  expect(f.requests.filter((request) => request.suffix === "/operations")).toHaveLength(
    0,
  );
});

test("Trash select-all freezes only rendered selectable entries", async ({ page }) => {
  const f = await actionsFixture(page);
  f.trash = Array.from({ length: 201 }, (_, index) =>
    trashEntry(`entry-${String(index).padStart(3, "0")}`),
  );
  await selectEnglish(page);
  await page.goto(baseURL + "/files?panel=trash");
  const first = page.getByRole("checkbox", {
    name: "Select entry-000.txt",
    exact: true,
  });
  await first.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Delete permanently", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete permanently", exact: true });
  await expect(dialog).toContainText("200 frozen entries");
  await expect(dialog).not.toContainText("/home/test/entry-200.txt");
  expect(f.requests.filter((request) => request.suffix === "/operations")).toHaveLength(
    0,
  );
});

test("Empty loads every page, freezes consent, bounds all bodies and stops after partial batch failure", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  f.trash = Array.from({ length: 900 }, (_, index) =>
    trashEntry(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
  );
  f.trash.push(
    trashEntry("pending", { availability: "pending", revision: null, size: null }),
  );
  const frozen = f.trash
    .filter((entry) => entry.availability === "recoverable")
    .map((entry) => entry.id);
  let batches = 0;
  f.onStart = (body, job) => {
    expect(body.kind).toBe("purge");
    batches++;
    expect(body.options.confirmation.map((item) => item.id)).toEqual(body.sources);
    expect(body.sources.every((id) => frozen.includes(id))).toBe(true);
    const rows = body.sources.map((source, index) => ({
      id: String(index),
      source,
      path: `/home/test/${source}.txt`,
      status: batches === 1 || index === 0 ? "completed" : "failed",
      sourceRemoved: batches === 1 || index === 0,
    }));
    f.finish(job.id, rows, batches === 1 ? "completed" : "partially_completed");
    f.trash = f.trash.filter(
      (entry) => !rows.some((row) => row.source === entry.id && row.sourceRemoved),
    );
    if (batches === 1) f.trash.push(trashEntry("arrived-after-consent"));
  };
  await selectEnglish(page);
  await page.goto(baseURL + "/files?panel=trash");
  await page.getByRole("button", { name: "Empty Trash", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete permanently", exact: true });
  await expect(dialog).toContainText("900 frozen entries");
  await expect(dialog).toContainText("1 nonrecoverable");
  expect(f.requests.filter((request) => request.suffix === "/trash")).toHaveLength(5);
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => batches).toBe(2);
  await expect(
    page.getByRole("region", { name: "Permanent deletion results" }),
  ).toContainText("Permanently removed");
  await expect(
    page.getByRole("region", { name: "Permanent deletion results" }),
  ).toContainText("Not submitted");
  await expect(
    page
      .getByRole("region", { name: "Permanent deletion results" })
      .getByRole("button", { name: "Stop", exact: true }),
  ).toHaveCount(0);
  const submitted = f.requests.filter((request) => request.suffix === "/operations");
  expect(submitted).toHaveLength(2);
  expect(new Set(submitted.map((request) => request.body.requestId)).size).toBe(2);
  expect(
    submitted.every(
      (request) => Buffer.byteLength(JSON.stringify(request.body)) <= 64 * 1024,
    ),
  ).toBe(true);
  expect(submitted.flatMap((request) => request.body.sources)).not.toContain(
    "arrived-after-consent",
  );
  expect(f.unknown).toEqual([]);
});

test("cancelling purge stops later batches and keeps unresolved recovery rows visible", async ({
  page,
  browserName,
}) => {
  const f = await actionsFixture(page);
  f.trash = [
    trashEntry("report"),
    trashEntry("interrupted", {
      reason: "interrupted_rename",
      availability: "pending",
      revision: null,
      size: null,
    }),
  ];
  f.onStart = () => {};
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/files?panel=trash");
  await expect(
    page.getByRole("checkbox", { name: "interrupted.txt auswählen", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "Papierkorb", exact: true }),
  ).toContainText("ungeprüft");
  await page.getByRole("button", { name: "Papierkorb leeren", exact: true }).click();
  await page.screenshot({
    path: `.superpowers/sdd/2026-09-13-file-explorer/screenshots/${browserName}-task12-de-mobile-purge.png`,
    fullPage: true,
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Bestätigen", exact: true })
    .click();
  await expect.poll(() => f.jobs.size).toBe(1);
  await page
    .getByRole("region", { name: "Ergebnisse des endgültigen Löschens" })
    .getByRole("button", { name: "Stoppen", exact: true })
    .click();
  await expect.poll(() => [...f.jobs.values()][0].status).toBe("cancelled");
  expect(f.trash).toHaveLength(2);
  expect(f.requests.filter((request) => request.suffix === "/operations")).toHaveLength(
    1,
  );
});

test("leaving Trash after a submitted batch prevents later batch submissions", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  f.trash = Array.from({ length: 500 }, (_, index) =>
    trashEntry(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
  );
  f.onStart = () => {};
  await selectEnglish(page);
  await page.goto(baseURL + "/files?panel=trash");
  await page.getByRole("button", { name: "Empty Trash", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect.poll(() => f.jobs.size).toBe(1);
  await page.getByRole("button", { name: "File list", exact: true }).click();
  await expect(page.getByRole("region", { name: "File actions" })).toBeVisible();
  const body = f.requests.find((request) => request.suffix === "/operations").body;
  f.finish(
    [...f.jobs.keys()][0],
    body.sources.map((source, index) => ({
      id: String(index),
      source,
      path: source,
      status: "completed",
      sourceRemoved: true,
    })),
  );
  await expect(page.getByRole("region", { name: "File jobs" })).toContainText(
    "Completed entries",
  );
  expect(f.jobs.size).toBe(1);
});

test("a lost purge acknowledgement is shown as submitted and uncertain", async ({
  page,
}) => {
  await actionsFixture(page);
  await page.route("**/api/files/operations", (route) => route.abort("failed"));
  await selectEnglish(page);
  await page.goto(baseURL + "/files?panel=trash");
  await page.getByRole("button", { name: "Empty Trash", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  const results = page.getByRole("region", { name: "Permanent deletion results" });
  await expect(results).toContainText("Submitted; removal not yet proven");
  await expect(results).not.toContainText("Not submitted");
});

test("a stale restore decision can still be dismissed by cancelling its job", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  await page.route("**/api/files/jobs/*/resolve", (route) =>
    route.fulfill({ status: 409, json: { code: "FILE_CONFLICT_CHANGED" } }),
  );
  await selectEnglish(page);
  await page.goto(baseURL + "/files?panel=trash");
  await page.getByRole("checkbox", { name: "Select report.txt", exact: true }).check();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "File conflict", exact: true });
  await dialog.getByRole("button", { name: "Keep both", exact: true }).click();
  await expect(dialog).toContainText("This file conflict changed");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect([...f.jobs.values()][0].status).toBe("cancelled");
  expect(f.trash).toHaveLength(1);
});
