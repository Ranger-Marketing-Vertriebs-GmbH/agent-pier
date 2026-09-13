import {
  actionsFixture,
  revision,
  actionEntry,
} from "../helpers/file-actions-browser.js";
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { explorerFixture, selectEnglish } from "../helpers/file-explorer-browser.js";

test("file actions expose selection and dismissible create controls", async ({
  page,
}) => {
  await explorerFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("checkbox", { name: "Select readme.txt", exact: true }).check();
  await expect(page.getByRole("button", { name: "Cut", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New file", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// These fixtures expose the same bounded operation/results contracts as HTTP tests.
test("Shift selection, keyboard copy, rename and create submit frozen scoped references", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("checkbox", { name: "Select a.txt", exact: true }).check();
  await page
    .getByRole("checkbox", { name: "Select c.txt", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(
    page.getByRole("checkbox", { name: "Select b.txt", exact: true }),
  ).toBeChecked();
  await page.getByRole("checkbox", { name: "Select b.txt", exact: true }).uncheck();
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "docs", exact: true }).click();
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Destination: /home/test/docs");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect
    .poll(() => f.requests.filter((request) => request.suffix === "/operations").length)
    .toBe(1);
  const body = f.requests.find((request) => request.suffix === "/operations").body;
  expect(body.kind).toBe("copy");
  expect(body.sources).toEqual(["/home/test/a.txt", "/home/test/c.txt"]);
  expect(body.options.revisions).toEqual({
    "/home/test/a.txt": revision,
    "/home/test/c.txt": revision,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Parent directory", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select a.txt", exact: true }).check();
  await page.keyboard.press("F2");
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("renamed.txt");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "renamed.txt", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("created");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "created", exact: true })).toBeVisible();
  expect(f.unknown).toEqual([]);
});

test("partial Cut retains failed and unproven sources and ignores an obsolete clipboard generation", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  f.onStart = (body, job) => {
    expect(body.kind).toBe("move");
    f.rows.set(
      job.id,
      body.sources.map((source, index) => ({
        id: String(index),
        source,
        path: `/home/test/docs/${source.split("/").at(-1)}`,
        status: "pending",
        sourceRemoved: false,
      })),
    );
  };
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  for (const name of ["a.txt", "b.txt", "c.txt"])
    await page.getByRole("checkbox", { name: `Select ${name}`, exact: true }).check();
  await page.getByRole("button", { name: "Cut", exact: true }).click();
  await page.getByRole("button", { name: "docs", exact: true }).click();
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect.poll(() => f.jobs.size).toBe(1);
  const id = [...f.jobs.keys()][0];
  f.finish(
    id,
    [
      {
        id: "0",
        source: "/home/test/a.txt",
        path: "/home/test/docs/a.txt",
        status: "completed",
        outputPublished: true,
        sourceRemoved: true,
      },
      {
        id: "1",
        source: "/home/test/b.txt",
        path: "/home/test/docs/b.txt",
        status: "failed",
        sourceRemoved: false,
        issue: { code: "FILE_ACCESS_DENIED", args: {} },
      },
      {
        id: "2",
        source: "/home/test/c.txt",
        path: "/home/test/docs/c.txt",
        status: "published",
        outputPublished: true,
        sourceRemoved: false,
        sourceRemovalPending: true,
      },
    ],
    "partially_completed",
  );
  await expect(page.getByRole("region", { name: "File actions" })).toContainText(
    "Cut: 2 references",
  );
  await expect(page.getByRole("region", { name: "File jobs" })).toContainText(
    "Source removal is unproven",
  );
  await page.getByRole("button", { name: "Parent directory", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select b.txt", exact: true }).check();
  await page.getByRole("button", { name: "Cut", exact: true }).click();
  f.finish(
    id,
    f.rows.get(id).map((row) => ({
      ...row,
      sourceRemoved: true,
      status: "completed",
      sourceRemovalPending: false,
    })),
  );
  await expect(page.getByRole("region", { name: "File jobs" })).toContainText(
    "Move · Completed",
  );
  await expect(page.getByRole("region", { name: "File actions" })).toContainText(
    "Cut: 1 references",
  );
  expect(f.unknown).toEqual([]);
});

test("internal drag names its destination, external drops do not create operations", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const source = page.getByRole("button", { name: "a.txt", exact: true }).locator("..");
  const target = page.getByRole("button", { name: "docs", exact: true }).locator("..");
  await source.dragTo(target);
  await expect(page.getByRole("dialog", { name: "Move", exact: true })).toContainText(
    "Destination: /home/test/docs",
  );
  expect(f.requests.filter((request) => request.suffix === "/operations")).toHaveLength(
    0,
  );
  await page.keyboard.press("Escape");
  await target.dispatchEvent("drop", {
    dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await source.dragTo(target);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect
    .poll(() => f.requests.some((request) => request.body?.kind === "move"))
    .toBe(true);
  expect(f.requests.find((request) => request.body?.kind === "move").body.target).toBe(
    "/home/test/docs",
  );
});

test("stale selections and dialogs disappear on refresh and path navigation", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("checkbox", { name: "Select a.txt", exact: true }).check();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.evaluate(() => {
    history.pushState({}, "", "/files?path=%2Fhome%2Ftest%2Fdocs");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Parent directory", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select a.txt", exact: true }).check();
  f.files = f.files.map((entry) =>
    entry.name === "a.txt"
      ? actionEntry("a.txt", "file", "/home/test", { revision: `e1:${"c".repeat(64)}` })
      : entry,
  );
  await page.getByRole("button", { name: "Refresh file list", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Select a.txt", exact: true }),
  ).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();
  expect(f.requests.filter((request) => request.suffix === "/operations")).toHaveLength(
    0,
  );
});

test("German touch menus and English desktop actions remain visible", async ({
  page,
  browserName,
}) => {
  const f = await actionsFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/files");
  await page.getByRole("button", { name: "Aktionen für a.txt", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: "Kopieren", exact: true }).click();
  await expect(page.getByRole("button", { name: "Einfügen", exact: true })).toBeEnabled();
  await page.screenshot({
    path: `.superpowers/sdd/2026-09-13-file-explorer/screenshots/${browserName}-task12-de-mobile-actions.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await expect(
    page.getByRole("button", { name: "Actions for a.txt", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `.superpowers/sdd/2026-09-13-file-explorer/screenshots/${browserName}-task12-en-desktop-actions.png`,
    fullPage: true,
  });
  expect(f.unknown).toEqual([]);
});

test("typed copy conflicts require explicit merge consent and Escape cancels the current waiter", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  f.files.push(actionEntry("target", "directory"));
  f.folders.set("/home/test/target", [
    actionEntry("docs", "directory", "/home/test/target"),
  ]);
  f.onStart = (body, job) => {
    Object.assign(job, {
      status: "waiting_for_conflict",
      conflict: {
        id: `conflict-${job.id}`,
        type: "name",
        source: "/home/test/docs",
        target: "/home/test/target/docs",
        sourceType: "directory",
        targetType: "directory",
        sourceRevision: revision,
        targetRevision: revision,
        choices: ["merge", "skip", "keep_both", "cancel"],
      },
    });
  };
  f.onResolve = (body, job) => {
    if (body.decision === "merge") expect(body.applyToRemaining).toBe(true);
    f.finish(job.id, [], body.decision === "cancel" ? "cancelled" : "completed");
  };
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("checkbox", { name: "Select docs", exact: true }).check();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByRole("button", { name: "target", exact: true }).click();
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "File conflict", exact: true });
  await expect(dialog).toContainText("existing destination folder keeps its owner");
  await expect(dialog.getByRole("button", { name: "Replace", exact: true })).toHaveCount(
    0,
  );
  await dialog
    .getByRole("checkbox", {
      name: "Apply to remaining conflicts of the same type",
      exact: true,
    })
    .check();
  await dialog.getByRole("button", { name: "Merge folders", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "File conflict", exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect([...f.jobs.values()].at(-1).status).toBe("cancelled");
});

test("path-copy writes exact selected paths and a failed create retries its immutable request", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copiedPaths = text;
        },
      },
    });
  });
  let attempts = 0;
  const bodies = [];
  await page.route("**/api/files/operations", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (attempts++ === 0)
      return route.fulfill({ status: 503, json: { code: "FILE_IO_ERROR" } });
    return route.fallback();
  });
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("checkbox", { name: "Select a.txt", exact: true }).check();
  await page.getByRole("button", { name: "Copy path", exact: true }).click();
  expect(await page.evaluate(() => window.copiedPaths)).toBe("/home/test/a.txt");
  await page.getByRole("button", { name: "New file", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New file", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("new.txt");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toContainText("could not be completed");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(f.requests.filter((request) => request.suffix === "/operations")).toHaveLength(
    1,
  );
});
