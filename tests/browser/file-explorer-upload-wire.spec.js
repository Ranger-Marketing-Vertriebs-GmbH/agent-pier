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
  try {
    await selectEnglish(page);
    await page.goto(`${baseURL}/files?path=${encodeURIComponent(destination)}`);
    await page.getByLabel("Upload folder", { exact: true }).setInputFiles(selection);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(path.join(destination, "root"));
    expect(puts).toHaveLength(0);
    await dialog.getByRole("button", { name: "Keep both", exact: true }).click();
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
    await fs.rm(directory, { recursive: true, force: true });
  }
});
