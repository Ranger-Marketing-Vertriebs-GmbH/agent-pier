import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { explorerFixture, selectEnglish } from "../helpers/file-explorer-browser.js";
import { uploadsFixture } from "../helpers/file-uploads-browser.js";

const source = (name, buffer = Buffer.from(name)) => ({
  name,
  mimeType: "application/octet-stream",
  buffer,
});

test("uploads provide native file and folder inputs and an explicit drop destination", async ({
  page,
}) => {
  await explorerFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await expect(page.getByLabel("Upload files", { exact: true })).toBeAttached();
  await expect(page.getByLabel("Upload folder", { exact: true })).toBeAttached();
  await expect(page.getByRole("region", { name: "Uploads", exact: true })).toContainText(
    "/home/test",
  );
});

test("failed-only retry preserves completed bytes and creates one new explicit attempt", async ({
  page,
}) => {
  const { state: f } = await uploadsFixture(page);
  f.failures.add("second.txt");
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const bytes = Buffer.alloc(131072, 173);
  await page
    .getByLabel("Upload files", { exact: true })
    .setInputFiles([source("first.bin", bytes), source("second.txt")]);
  await page.getByRole("button", { name: "Retry second.txt", exact: true }).click();
  await expect(page.getByRole("region", { name: "Uploads", exact: true })).toContainText(
    "Upload completed",
  );
  expect(f.raw.filter((item) => item.declaration.name === "first.bin")).toHaveLength(1);
  expect(f.raw[0].body).toEqual(bytes);
  const retried = f.raw.filter((item) => item.declaration.name === "second.txt");
  expect(retried).toHaveLength(2);
  expect(retried[0].id).not.toBe(retried[1].id);
  expect(retried[0].declaration.requestId).not.toBe(retried[1].declaration.requestId);
});

test("three XHRs bound multiple selections across folder navigation", async ({
  page,
}) => {
  const { state: f } = await uploadsFixture(page);
  f.hold = true;
  try {
    await selectEnglish(page);
    await page.goto(baseURL + "/files");
    await page
      .getByLabel("Upload files", { exact: true })
      .setInputFiles([1, 2, 3, 4].map((n) => source(`${n}.txt`)));
    await expect.poll(() => f.raw.length).toBe(3);
    await page.getByRole("button", { name: "docs", exact: true }).click();
    await page
      .getByLabel("Upload files", { exact: true })
      .setInputFiles(source("new.txt"));
    expect(f.raw).toHaveLength(3);
    f.finish(f.raw[0].id);
    await expect.poll(() => f.raw.length).toBe(4);
    f.release();
    await expect.poll(() => f.raw.length).toBe(5);
    await expect(
      page.getByRole("region", { name: "Uploads", exact: true }),
    ).toContainText("Upload completed");
    expect(f.peak).toBe(3);
    expect(
      f.raw
        .filter((item) => item.declaration.name !== "new.txt")
        .every((item) => item.declaration.path === "/home/test"),
    ).toBe(true);
    expect(
      f.raw.find((item) => item.declaration.name === "new.txt").declaration.path,
    ).toBe("/home/test/docs");
  } finally {
    f.release();
  }
});

test("server reset reconciles the retained job without sending another body", async ({
  page,
}) => {
  const { state: f } = await uploadsFixture(page);
  f.reset.add("reset.txt");
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page
    .getByLabel("Upload files", { exact: true })
    .setInputFiles(source("reset.txt"));
  await expect(
    page.getByRole("button", { name: "Retry reset.txt", exact: true }),
  ).toBeEnabled();
  expect(f.raw).toHaveLength(1);
  expect(
    f.requests.some(
      (item) => item.method === "GET" && item.suffix === `/jobs/${f.raw[0].id}`,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Retry reset.txt", exact: true }).click();
  await expect(page.getByRole("region", { name: "Uploads", exact: true })).toContainText(
    "Upload completed",
  );
  expect(f.raw).toHaveLength(2);
});

test("lost metadata and child replies preserve immutable request identities", async ({
  page,
}) => {
  const { state: f } = await uploadsFixture(page);
  for (const key of ["create", "append", "commit", "child"]) f.lose.add(key);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page
    .getByLabel("Upload files", { exact: true })
    .setInputFiles(source("lost.txt"));
  for (let n = 0; n < 3; n++) {
    await page.getByRole("button", { name: "Check upload request", exact: true }).click();
    await expect.poll(() => f.lose.size).toBeLessThan(3 - n);
  }
  await page.getByRole("button", { name: "Check result lost.txt", exact: true }).click();
  await expect(page.getByRole("region", { name: "Uploads", exact: true })).toContainText(
    "Upload completed",
  );
  expect(f.groups.size).toBe(1);
  expect(f.attempts.size).toBe(1);
  expect(f.raw).toHaveLength(1);
  for (const suffix of ["/upload-groups", "/uploads"]) {
    const requests = f.requests.filter((item) => item.suffix === suffix);
    expect(requests).toHaveLength(2);
    expect(requests[0].body).toEqual(requests[1].body);
  }
});

test("external directory drop preserves an empty folder and ignores internal gestures", async ({
  page,
}) => {
  const { state: f } = await uploadsFixture(page);
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer(),
      file = new File(["nested"], "same.txt");
    data.items.add(file);
    const directory = (name, children) => ({
      name,
      isDirectory: true,
      createReader() {
        let read = false;
        return {
          readEntries(done) {
            done(read ? [] : children);
            read = true;
          },
        };
      },
    });
    Object.defineProperty(data, "items", {
      value: [
        {
          kind: "file",
          webkitGetAsEntry: () =>
            directory("root", [
              { name: "same.txt", isFile: true, file: (done) => done(file) },
              directory("empty", []),
            ]),
        },
      ],
    });
    return data;
  });
  const zone = page.getByRole("region", { name: "Upload destination", exact: true });
  await zone.dispatchEvent("dragover", { dataTransfer: transfer });
  await zone.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByRole("region", { name: "Uploads", exact: true })).toContainText(
    "Upload completed",
  );
  const rows = [...[...f.groups.values()][0].entries.values()];
  expect(rows).toHaveLength(3);
  expect(
    rows.some((row) => row.relativePath === "root/empty" && row.type === "directory"),
  ).toBe(true);
  await transfer.evaluate((data) =>
    data.setData("application/x-agentpier-files", "unowned"),
  );
  await zone.dispatchEvent("drop", { dataTransfer: transfer });
  expect(f.groups.size).toBe(1);
});

test("selected history discovers directory conflicts beyond 200 and cancels actual recovered children", async ({
  page,
}) => {
  const { state: f } = await uploadsFixture(page);
  f.oldJobs(200);
  const rows = Array.from({ length: 201 }, (_, n) => ({
    id: `d${n}`,
    relativePath: `dir${n}`,
    path: `/home/test/dir${n}`,
    type: "directory",
    bytes: 0,
    status: n === 200 ? "running" : "completed",
  }));
  rows.push({
    id: "file",
    relativePath: "waiting.txt",
    path: "/home/test/waiting.txt",
    type: "file",
    bytes: 2,
    status: "running",
  });
  const group = f.seed(rows, { status: "running" });
  for (let n = 0; n < 201; n++)
    f.child(group, `d${n}`, {
      status: n === 200 ? "waiting_for_conflict" : "completed",
      ...(n === 200
        ? {
            conflict: {
              id: "directory-conflict",
              source: null,
              target: "/home/test/dir200",
              sourceType: "directory",
              targetType: "file",
              choices: ["skip", "keep_both", "cancel"],
            },
          }
        : {}),
    });
  const child = f.child(group, "file", { status: "running" });
  await selectEnglish(page);
  await page.goto(baseURL + "/files");
  await page.getByText("Recover an upload", { exact: true }).click();
  await page.getByRole("button", { name: "Next job page", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`Upload ${group.job.id}`) }).click();
  await expect(page.getByRole("dialog")).toContainText("/home/test/dir200");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Keep both", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Next transfers", exact: true }).click();
  await page.getByRole("button", { name: "Cancel waiting.txt", exact: true }).click();
  await expect
    .poll(() => f.requests.some((item) => item.suffix === `/jobs/${child.id}/cancel`))
    .toBe(true);
  expect(f.raw).toHaveLength(0);
  expect(
    f.requests
      .filter((item) => item.suffix.endsWith("/upload-children"))
      .some((item) => item.cursor),
  ).toBe(true);
});
