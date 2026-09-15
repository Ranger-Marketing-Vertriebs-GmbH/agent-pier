import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { baseURL } from "../helpers/browser.js";
import { selectEnglish } from "../helpers/file-explorer-browser.js";

test("actual receiver publishes native folder bytes after an authoritative directory conflict remap", async ({
  page,
  request,
}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-upload-wire-"));
  const destination = path.join(directory, "target"),
    selection = path.join(directory, "root");
  await fs.mkdir(destination);
  await fs.mkdir(path.join(selection, "nested"), { recursive: true });
  const binary = Buffer.alloc(262144, 183);
  await fs.writeFile(path.join(selection, "nested", "same.bin"), binary);
  await fs.writeFile(path.join(destination, "root"), "existing target");
  const reservations = [],
    puts = [],
    mutations = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname === "/api/files/uploads" && req.method() === "POST")
      reservations.push(req.postDataJSON());
    if (/\/uploads\/[^/]+\/content$/.test(url.pathname)) puts.push(req);
    if (req.method() === "POST" && url.pathname.startsWith("/api/files/"))
      mutations.push({ path: url.pathname, body: req.postDataJSON() });
  });
  let selecting;
  try {
    await selectEnglish(page);
    await page.goto(`${baseURL}/files?path=${encodeURIComponent(destination)}`);
    // The conflict proves the app received Files while native selection may be pending.
    selecting = page
      .getByLabel("Upload folder", { exact: true })
      .setInputFiles(selection)
      .then(
        () => null,
        (error) => error,
      );
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(path.join(destination, "root"));
    expect(puts).toHaveLength(0);
    await dialog.getByRole("button", { name: "Keep both", exact: true }).click();
    const selectionError = await selecting;
    if (selectionError) throw selectionError;
    await expect(
      page.getByRole("region", { name: "Uploads", exact: true }),
    ).toContainText("Upload completed", { timeout: 20000 });
    expect(reservations).toHaveLength(1);
    expect(puts).toHaveLength(1);
    const manifest = await (
      await request.get(`/api/files/jobs/${reservations[0].groupId}/entries`)
    ).json();
    const row = manifest.entries.find((entry) => entry.id === reservations[0].entryId);
    expect(row.relativePath).toBe("root/nested/same.bin");
    expect(row.path).not.toBe(path.join(destination, "root", "nested", "same.bin"));
    expect(row.status).toBe("completed");
    expect(row.outputPublished).toBe(true);
    expect(row.path.startsWith((await fs.realpath(destination)) + path.sep)).toBe(true);
    expect(await fs.readFile(row.path)).toEqual(binary);
    expect(await fs.readFile(path.join(destination, "root"), "utf8")).toBe(
      "existing target",
    );
    expect((await fs.stat(row.path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(row.path))).mode & 0o777).toBe(0o700);
    expect(puts[0].headers()["content-type"]).toBe("application/octet-stream");
    expect(mutations.filter((item) => item.path.endsWith("/resolve"))).toHaveLength(1);
    await expect(
      page.getByRole("region", { name: "Uploads", exact: true }),
    ).toContainText(row.path);
  } finally {
    await selecting;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a directory remap before child admission refuses old metadata and explicit retry claims the refreshed path once", async ({
  page,
  request,
}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-upload-refusal-"));
  const destination = path.join(directory, "target"),
    selection = path.join(directory, "root");
  await fs.mkdir(destination);
  await fs.mkdir(selection);
  const binary = Buffer.alloc(131072, 219);
  await fs.writeFile(path.join(selection, "same.bin"), binary);
  await fs.writeFile(path.join(destination, "root"), "preserved target");
  const held = Promise.withResolvers(),
    reservations = [],
    responses = [],
    puts = [];
  await page.route("**/api/files/uploads", async (route) => {
    reservations.push(route.request().postDataJSON());
    if (reservations.length === 1) await held.promise;
    await route.continue();
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/files/uploads")
      responses.push(response.status());
  });
  page.on("request", (req) => {
    if (/\/uploads\/[^/]+\/content$/.test(new URL(req.url()).pathname)) puts.push(req);
  });
  let selecting;
  try {
    await selectEnglish(page);
    await page.goto(`${baseURL}/files?path=${encodeURIComponent(destination)}`);
    // Native directory automation can still be pending after the app received Files.
    // Own its result while the captured POST proves the app processed the selection.
    selecting = page
      .getByLabel("Upload folder", { exact: true })
      .setInputFiles(selection)
      .then(
        () => null,
        (error) => error,
      );
    await expect.poll(() => reservations.length).toBe(1);
    const original = reservations[0],
      groupURL = `/api/files/jobs/${original.groupId}`;
    const readChildren = async () =>
      (await (await request.get(`${groupURL}/upload-children`)).json()).children;
    let conflict;
    await expect
      .poll(async () => {
        conflict = (await readChildren()).find(
          (child) =>
            child.job?.kind === "create_directory" &&
            child.job.status === "waiting_for_conflict",
        );
        return Boolean(conflict);
      })
      .toBe(true);
    // A second legitimate client resolves while this client's serial POST is held.
    const context = await (await request.get("/api/files/context")).json();
    const resolved = await request.post(`/api/files/jobs/${conflict.job.id}/resolve`, {
      headers: { "X-File-Scope": context.scopeId, Origin: baseURL },
      data: {
        conflictId: conflict.job.conflict.id,
        decision: "keep_both",
        applyToRemaining: false,
      },
    });
    expect(resolved.ok()).toBe(true);
    let row;
    await expect
      .poll(async () => {
        const manifest = await (await request.get(`${groupURL}/entries`)).json();
        row = manifest.entries.find((entry) => entry.id === original.entryId);
        return (
          row?.path !== path.join(original.path, original.name) && row?.status === "ready"
        );
      })
      .toBe(true);
    held.resolve();
    const selectionError = await selecting;
    if (selectionError) throw selectionError;
    await expect.poll(() => responses).toEqual([409]);
    expect(await readChildren()).not.toContainEqual(
      expect.objectContaining({ entryId: original.entryId }),
    );
    expect(puts).toHaveLength(0);
    const uploads = page.getByRole("region", { name: "Uploads", exact: true });
    await expect(uploads).toContainText("Failed");
    await uploads
      .getByRole("button", { name: "Retry root/same.bin", exact: true })
      .click();
    await expect(uploads).toContainText("Upload completed", { timeout: 20000 });
    expect(responses).toEqual([409, 201]);
    expect(reservations).toHaveLength(2);
    expect(reservations[1].requestId).not.toBe(original.requestId);
    expect(reservations[1].entryId).toBe(original.entryId);
    expect(reservations[1].path).toBe(path.dirname(row.path));
    expect(puts).toHaveLength(1);
    const children = await readChildren();
    const child = children.find((item) => item.entryId === original.entryId).job;
    expect(puts[0].url()).toContain(`/uploads/${child.id}/content`);
    expect(child.status).toBe("completed");
    expect(await fs.readFile(row.path)).toEqual(binary);
    expect(await fs.readFile(path.join(destination, "root"), "utf8")).toBe(
      "preserved target",
    );
    await page.getByRole("button", { name: "Refresh file list", exact: true }).click();
    expect(reservations).toHaveLength(2);
    expect(puts).toHaveLength(1);
  } finally {
    held.resolve();
    await selecting;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
