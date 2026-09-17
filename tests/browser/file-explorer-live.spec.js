import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import {
  openExplorerDisclosure,
  openExplorerPanel,
} from "../helpers/file-explorer-layout.js";

async function cleanupAll(cleanups) {
  const errors = [];
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Task22 live fixture cleanup failed");
}

async function readTextWhenPresent(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function createEntry(page, kind, name) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page
    .getByRole("menu", { name: "New", exact: true })
    .getByRole("menuitem", {
      name: kind === "file" ? "New file" : "New folder",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: kind === "file" ? "New file" : "New folder",
  });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
}

test("owned live Explorer creates, transfers, edits, resolves and restores", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const cleanups = [];
  const fixtureOwner = { after: (cleanup) => cleanups.push(cleanup) };
  try {
    const f = await applicationFixture(fixtureOwner);
    const context = await browser.newContext({ acceptDownloads: true, locale: "de-DE" });
    // Surface the failed action before the overall timeout starts fixture teardown.
    context.setDefaultTimeout(10000);
    cleanups.push(() => context.close());
    await context.addCookies([
      {
        name: "agentpier_session",
        value: f.cookie.slice(f.cookie.indexOf("=") + 1),
        url: f.url,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(`${f.url}/settings`);
    await page.getByLabel("Sprache", { exact: true }).selectOption("en");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await page.goto(`${f.url}/files`);
    await expect(
      page.getByRole("region", { name: "File list", exact: true }),
    ).toBeVisible();

    const folderName = `task22-${randomUUID()}`;
    await createEntry(page, "folder", folderName);
    await page.getByRole("button", { name: folderName, exact: true }).click();
    const folder = path.join(f.home, folderName);
    await openExplorerDisclosure(page, ".explorer-path-options");
    await expect(page.getByLabel("Path", { exact: true })).toHaveValue(folder);

    await createEntry(page, "file", "document.txt");
    const document = path.join(folder, "document.txt");
    const binaryName = "unsupported-ä.bin";
    const binary = Buffer.from([0, 1, 2, 3, 255, 128, 65, 66]);
    await openExplorerPanel(page, "uploads");
    await page.getByLabel("Upload files", { exact: true }).setInputFiles({
      name: binaryName,
      mimeType: "application/octet-stream",
      buffer: binary,
    });
    await expect(page.getByText("Upload completed", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: binaryName, exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: binaryName, exact: true }).click();
    const properties = page.getByRole("region", {
      name: "File properties",
      exact: true,
    });
    await expect(properties).toContainText("This file type cannot be previewed.");
    const downloadLink = properties.getByRole("link", {
      name: "Download file",
      exact: true,
    });
    const encodedPath = new URLSearchParams({ path: path.join(folder, binaryName) })
      .toString()
      .slice(5);
    const expectedDownload = `/api/files/download?path=${encodedPath}`;
    await expect(downloadLink).toHaveAttribute("href", expectedDownload);
    const response = await context.request.get(f.url + expectedDownload);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      downloadLink.click(),
    ]);
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["content-length"]).toBe(String(binary.length));
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-disposition"]).toContain("attachment;");
    expect(headers["content-disposition"]).toContain("unsupported-%C3%A4.bin");
    expect(await response.body()).toEqual(binary);
    expect(await download.failure()).toBeNull();
    expect(await fs.readFile(await download.path())).toEqual(binary);

    await page.getByRole("button", { name: "document.txt", exact: true }).click();
    await page.getByRole("button", { name: "Open in editor", exact: true }).click();
    const editor = page.getByRole("textbox", { name: `Document content: ${document}` });
    await expect(editor).toBeVisible();
    if (process.platform === "darwin") {
      await editor.fill("first-save");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
      await editor.fill("local-edit");
      await fs.writeFile(document, "disk-edit!");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        page.getByText("The selected document changed on disk."),
      ).toBeVisible();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const conflict = page.getByRole("region", { name: "Conflict comparison" });
      await expect(conflict).toBeVisible();
      await conflict
        .getByRole("button", { name: "Replace at current revision", exact: true })
        .click();
      await expect.poll(() => fs.readFile(document, "utf8")).toBe("local-edit");
      await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    } else {
      await expect(
        page.getByRole("button", { name: "Save", exact: true }),
      ).toBeDisabled();
      const copy = path.join(folder, "linux-save-as.txt");
      await page.getByLabel("Save As path", { exact: true }).fill(copy);
      await page.getByRole("button", { name: "Save new copy", exact: true }).click();
      await expect.poll(() => readTextWhenPresent(copy)).toBe("");
      await test.step("observe the completed Save As job before changing the source", async () => {
        await openExplorerPanel(page, "activity");
        // Disk publication precedes the jobs poll and its listing refresh.
        await expect(
          page.getByRole("region", { name: "File jobs", exact: true }),
        ).toContainText("Save text · Completed");
      });
      await fs.writeFile(document, "external");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        page.getByText("The selected document changed on disk."),
      ).toBeVisible();
    }

    await page.getByRole("button", { name: "File list", exact: true }).click();
    await page.getByRole("button", { name: "Refresh file list", exact: true }).click();
    const documentRow = page.locator(".explorer-entry").filter({
      has: page.getByRole("button", { name: "document.txt", exact: true }),
    });
    await expect(documentRow.locator(":scope > span").nth(1)).toHaveText(
      process.platform === "darwin" ? "10" : "8",
    );
    await test.step("confirm moving the refreshed document to Trash", async () => {
      await page
        .getByRole("checkbox", { name: "Select document.txt", exact: true })
        .check();
      await page.getByRole("button", { name: "Move to Trash", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Move to Trash" });
      await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
      // An empty list during refresh is not evidence that the action was accepted.
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(() =>
          fs.stat(document).then(
            () => true,
            (error) => {
              if (error.code === "ENOENT") return false;
              throw error;
            },
          ),
        )
        .toBe(false);
      await expect(
        page.getByRole("button", { name: "document.txt", exact: true }),
      ).toHaveCount(0);
    });
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page
      .locator(".file-trash-list li")
      .filter({ hasText: "Deleted" })
      .getByRole("checkbox", { name: "Select document.txt", exact: true })
      .check();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect
      .poll(() => readTextWhenPresent(document))
      .toBe(process.platform === "darwin" ? "local-edit" : "external");

    await page.goto(`${f.url}/settings`);
    await page.getByLabel("Language", { exact: true }).selectOption("de");
    await page.goto(
      `${f.url}/files?path=${encodeURIComponent(folder)}&file=${encodeURIComponent(path.join(folder, binaryName))}`,
    );
    await expect(
      page.getByRole("link", { name: "Datei herunterladen", exact: true }),
    ).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await cleanupAll(cleanups);
  }
});
