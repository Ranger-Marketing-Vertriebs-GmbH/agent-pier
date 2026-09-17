import { test, expect } from "@playwright/test";
import { actionsFixture, actionEntry } from "../helpers/file-actions-browser.js";
import { baseURL } from "../helpers/browser.js";
import { selectEnglish } from "../helpers/file-explorer-browser.js";

for (const [kind, label] of [
  ["create_file", "New file"],
  ["create_directory", "New folder"],
]) {
  test(`${label} submits while a completed job refreshes the listing`, async ({
    page,
  }) => {
    const f = await actionsFixture(page);
    f.onStart = () => {};
    await selectEnglish(page);
    await page.goto(baseURL + "/files");
    await page.getByRole("checkbox", { name: "Select a.txt", exact: true }).check();
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("renamed.txt");
    await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "a.txt", exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Select a.txt", exact: true }).check();
    await page.getByRole("button", { name: label, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: label, exact: true });
    await dialog.getByRole("textbox").fill("created");

    let release;
    const held = new Promise((resolve) => (release = resolve));
    let refreshing = false;
    await page.route("**/api/files/entries?**", async (route) => {
      refreshing = true;
      await held;
      await route.fallback();
    });
    f.finish("job-1", []);
    await expect.poll(() => refreshing).toBe(true);
    try {
      await expect(dialog.getByRole("button", { name: "Confirm" })).toBeEnabled();
      await dialog.getByRole("button", { name: "Confirm" }).click();
      await expect(dialog).toHaveCount(0);
      const body = f.requests
        .filter((request) => request.suffix === "/operations")
        .at(-1).body;
      expect(body.kind).toBe(kind);
      expect(body.sources).toEqual([]);
      expect(body.target).toBe("/home/test");
      expect(body.name).toBe("created");
    } finally {
      release();
    }
    expect(f.unknown).toEqual([]);
  });
}

test("rename stays paused until a refreshed source revision is validated", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByRole("checkbox", { name: "Select a.txt", exact: true }).check();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let refreshing = false;
  await page.route("**/api/files/entries?**", async (route) => {
    refreshing = true;
    await held;
    await route.fallback();
  });
  // Trigger the same refresh while the modal owns focus.
  await page
    .getByRole("button", { name: "Refresh file list", exact: true })
    .evaluate((button) => button.click());
  await expect.poll(() => refreshing).toBe(true);
  try {
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Confirm" }),
    ).toBeDisabled();
    f.files = f.files.map((entry) =>
      entry.name === "a.txt"
        ? actionEntry("a.txt", "file", "/home/test", { revision: `e1:${"c".repeat(64)}` })
        : entry,
    );
  } finally {
    release();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.requests.filter((request) => request.suffix === "/operations")).toEqual([]);
});

test("retiring completed job results does not refresh unchanged terminal jobs", async ({
  page,
}) => {
  const f = await actionsFixture(page);
  for (const id of ["job-1", "job-2"])
    f.jobs.set(id, {
      id,
      kind: "rename",
      status: "running",
      completedEntries: 0,
      totalEntries: 0,
      conflict: null,
    });
  for (const id of ["job-1", "job-2"]) f.rows.set(id, []);
  let terminal = false;
  const releases = [];
  const holds = [0, 1].map(() => new Promise((resolve) => releases.push(resolve)));
  const seen = new Set();
  await page.route("**/api/files/jobs/*/entries**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    if (terminal) {
      seen.add(id);
      await holds[id === "job-1" ? 0 : 1];
    }
    await route.fallback();
  });
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await expect(page.getByRole("button", { name: "a.txt", exact: true })).toBeVisible();
  terminal = true;
  f.finish("job-1", []);
  f.finish("job-2", []);
  try {
    await expect.poll(() => seen.has("job-1")).toBe(true);
    await expect(page.getByRole("button", { name: "a.txt", exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Select a.txt", exact: true }).check();
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const confirm = page.getByRole("dialog").getByRole("button", { name: "Confirm" });
    await expect(confirm).toBeEnabled();
    // Any unnecessary refresh now remains visible instead of racing the assertion.
    await page.route("**/api/files/entries?**", async (route) => {
      await holds[1];
      await route.fallback();
    });
    releases[0]();
    await expect.poll(() => seen.has("job-2")).toBe(true);
    await expect(confirm).toBeEnabled();
  } finally {
    for (const release of releases) release();
  }
});
