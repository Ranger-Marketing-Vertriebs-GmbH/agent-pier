import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  page,
  target,
  preview = { type: "text", text: "# Acceptance report\nVerified results" },
) {
  const explorerBase = "/api/sessions/links/files/explorer";
  const session = {
    id: "links",
    name: "File links",
    tool: "codex",
    cwd: "/fixture/repo",
    status: "running",
  };
  const previews = [];
  const explorerRequests = [];
  const unexpectedExplorerRequests = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith(explorerBase))
      explorerRequests.push({
        method: request.method(),
        path: url.pathname.slice(explorerBase.length),
        query: Object.fromEntries(url.searchParams),
      });
    let json = {};
    if (url.pathname === "/api/state")
      json = {
        tools: [{ id: "codex", name: "Codex", installed: true }],
        accounts: [],
        home: "/fixture",
        sessions: [session],
      };
    else if (url.pathname.endsWith("/chat"))
      json = {
        availability: "ready",
        tasks: [],
        messages: [
          {
            id: "answer",
            role: "assistant",
            text: `[Abnahmebericht](<${target}>)\n\n[Website](https://example.com/report)`,
          },
        ],
      };
    else if (url.pathname === `${explorerBase}/context`)
      json = {
        scopeId: `f1:${session.cwd}`,
        kind: "project",
        root: session.cwd,
        home: "/fixture",
        readOnly: false,
        limits: { listPageSize: 200, listEntries: 100000 },
      };
    else if (url.pathname === `${explorerBase}/preferences`)
      json = { favorites: [], showHidden: false };
    else if (url.pathname === `${explorerBase}/entries`)
      json = {
        path: url.searchParams.get("path") || "",
        parent: null,
        entries: [],
        total: 0,
        page: 1,
        pageSize: 200,
        hasMore: false,
        snapshotId: "snapshot-links",
      };
    else if (url.pathname === `${explorerBase}/metadata`) {
      const file = url.searchParams.get("path");
      if (file.startsWith("/"))
        return route.fulfill({
          status: 403,
          json: {
            error: "Dateioperation fehlgeschlagen.",
            code: "FILE_OUTSIDE_SCOPE",
            args: {},
          },
        });
      json = {
        path: file,
        name: file.split("/").at(-1),
        type: "file",
        size: 36,
        modifiedAt: "2026-09-13T10:00:00.000Z",
        mode: 0o600,
        readable: true,
        writable: true,
        linkTarget: null,
        revision: "e1:fixture",
      };
    } else if (url.pathname === `${explorerBase}/preview`) {
      const file = url.searchParams.get("path");
      previews.push(file);
      json = { ...preview, path: file };
    } else if (url.pathname.startsWith(explorerBase)) {
      unexpectedExplorerRequests.push({ method: request.method(), path: url.pathname });
      return route.fulfill({
        status: 500,
        json: { error: "Unexpected explorer request", code: "FILE_IO_ERROR", args: {} },
      });
    }
    return route.fulfill({ json });
  });
  await page.goto(baseURL + "/sessions/links/chat");
  return { explorerRequests, previews, session, unexpectedExplorerRequests };
}

for (const target of [
  "docs/report.md",
  "/fixture/repo/docs/report.md:12",
  "file:///fixture/repo/docs/report.md#L12",
  "docs/report%20final.md",
]) {
  test(`local chat link opens the project preview: ${target}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const requests = await fixture(page, target);
    await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
    await expect(page.getByLabel("Dateivorschau")).toContainText("Verified results");
    const expectedPath = target.includes("final")
      ? "docs/report final.md"
      : "docs/report.md";
    expect(requests.previews).toEqual([expectedPath]);
    expect(requests.explorerRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", path: "/context" }),
        expect.objectContaining({ method: "GET", path: "/preferences" }),
        expect.objectContaining({
          method: "GET",
          path: "/entries",
          query: expect.objectContaining({ path: "" }),
        }),
        { method: "GET", path: "/metadata", query: { path: expectedPath } },
        { method: "GET", path: "/preview", query: { path: expectedPath } },
      ]),
    );
    expect(requests.unexpectedExplorerRequests).toEqual([]);
    expect(page.context().pages()).toHaveLength(1);
    if (target === "docs/report.md")
      await page.screenshot({ path: ".cache/chat-file-preview-mobile.png" });
    await page.goBack();
    await expect(
      page.getByRole("link", { name: "Abnahmebericht", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Website", exact: true }),
    ).toHaveAttribute("href", "https://example.com/report");
  });
}

test("outside-project links show the bounded file error inside the app", async ({
  page,
}) => {
  const requests = await fixture(page, "/outside/report.md");
  await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "außerhalb des Projektverzeichnisses",
  );
  expect(requests.explorerRequests).toContainEqual({
    method: "GET",
    path: "/metadata",
    query: { path: "/outside/report.md" },
  });
  expect(requests.previews).toEqual([]);
  expect(requests.unexpectedExplorerRequests).toEqual([]);
  await expect(page.getByRole("button", { name: "Alles kopieren" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("npm run build");
});

async function clipboardFixture(page, mode = "success") {
  // Capture writes without replacing the user's system clipboard.
  await page.addInitScript((mode) => {
    window.clipboardWrites = [];
    window.clipboardWriteCompletions = [];
    window.completeClipboardWrite = () => window.clipboardWriteCompletions.shift()?.();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value:
        mode === "unavailable"
          ? undefined
          : {
              writeText: async (text) => {
                if (mode === "denied") throw new Error("Clipboard permission denied");
                if (mode === "pending")
                  await new Promise((resolve) => {
                    window.clipboardWriteCompletions.push(resolve);
                  });
                window.clipboardWrites.push(text);
              },
            },
    });
  }, mode);
}

for (const english of [false, true]) {
  test.describe(english ? "English copy all" : "German copy all", () => {
    test.use({ locale: english ? "en-GB" : "de-DE" });

    test("copies the complete Markdown source from a chat file link", async ({
      page,
      browserName,
    }) => {
      await page.setViewportSize({ width: english ? 1440 : 390, height: 844 });
      const content = "# Überprüfung ✓\n\n- **Alles** kopieren\n\tcode <tag>  \n";
      await clipboardFixture(page);
      await fixture(page, "docs/report-with-a-long-filename.md", {
        type: "text",
        text: content,
      });
      await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
      const preview = page.getByLabel(english ? "File preview" : "Dateivorschau");
      await preview
        .getByRole("button", { name: english ? "Copy all" : "Alles kopieren" })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.clipboardWrites))
        .toEqual([content]);
      await expect(preview.getByRole("status")).toHaveText(
        english ? "Copied to clipboard." : "In die Zwischenablage kopiert.",
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `.superpowers/sdd/2026-09-13-file-explorer/screenshots/${browserName}-${english ? "en-desktop-1440x844" : "de-mobile-390x844"}-copy-all.png`,
      });
    });

    test("reports a denied clipboard write and allows retrying", async ({ page }) => {
      await clipboardFixture(page, "denied");
      await fixture(page, "docs/report.md");
      await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
      const preview = page.getByLabel(english ? "File preview" : "Dateivorschau");
      const button = preview.getByRole("button", {
        name: english ? "Copy all" : "Alles kopieren",
      });
      await button.click();
      await expect(preview.getByRole("alert")).toContainText(
        english ? "could not be copied" : "konnte nicht kopiert werden",
      );
      await expect(preview.getByRole("status")).toHaveCount(0);
      await page.evaluate(() => {
        navigator.clipboard.writeText = async (text) => window.clipboardWrites.push(text);
      });
      await button.click();
      await expect(preview.getByRole("status")).toBeVisible();
      await expect(preview.getByRole("alert")).toHaveCount(0);
      expect(await page.evaluate(() => window.clipboardWrites)).toEqual([
        "# Acceptance report\nVerified results",
      ]);
    });
  });
}

test("copies empty files and reports an unavailable clipboard", async ({ page }) => {
  await clipboardFixture(page, "unavailable");
  await fixture(page, "empty.txt", { type: "text", text: "" });
  await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
  const button = page.getByRole("button", { name: "Alles kopieren" });
  await button.click();
  await expect(page.getByRole("alert")).toContainText("konnte nicht kopiert werden");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text) => window.clipboardWrites.push(text) },
    });
  });
  await button.click();
  await expect(page.getByLabel("Dateivorschau").getByRole("status")).toBeVisible();
  expect(await page.evaluate(() => window.clipboardWrites)).toEqual([""]);
});

test("does not offer text copying for image previews", async ({ page }) => {
  await fixture(page, "image.png", {
    type: "image",
    source:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  });
  await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
  await expect(page.getByLabel("Dateivorschau").getByRole("img")).toBeVisible();
  await expect(page.getByRole("button", { name: "Alles kopieren" })).toHaveCount(0);
});

test("pending copy feedback stays with its file when another preview opens", async ({
  page,
}) => {
  await clipboardFixture(page, "pending");
  await fixture(page, "docs/report.md");
  await page.route("**/api/sessions/links/files/explorer/entries?**", (route) =>
    route.fulfill({
      json: {
        path: "",
        parent: null,
        entries: [
          {
            name: "next.txt",
            path: "docs/next.txt",
            type: "file",
            size: 18,
            modifiedAt: "2026-09-13T10:00:00.000Z",
            mode: 0o600,
            readable: true,
            writable: true,
            linkTarget: null,
            revision: "e1:next",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 200,
        hasMore: false,
        snapshotId: "snapshot-next",
      },
    }),
  );
  await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
  const button = page.getByRole("button", { name: "Alles kopieren" });
  await button.click();
  await expect(button).toBeDisabled();
  await page.getByRole("button", { name: "next.txt", exact: true }).click();
  await expect(page.getByLabel("Dateivorschau")).toContainText("docs/next.txt");
  await expect(button).toBeEnabled();
  await page.evaluate(() => window.completeClipboardWrite());
  await expect.poll(() => page.evaluate(() => window.clipboardWrites.length)).toBe(1);
  await expect(page.getByLabel("Dateivorschau").getByRole("status")).toHaveCount(0);
});

test("does not expose previous text while the next preview is pending", async ({
  page,
}) => {
  await clipboardFixture(page);
  await fixture(page, "docs/report.md");
  const nextPreview = deferred();
  const nextStarted = deferred();
  await page.route("**/api/sessions/links/files/explorer/entries?**", (route) =>
    route.fulfill({
      json: {
        path: "",
        parent: null,
        entries: [
          {
            name: "next.txt",
            path: "docs/next.txt",
            type: "file",
            size: 18,
            modifiedAt: "2026-09-13T10:00:00.000Z",
            mode: 0o600,
            readable: true,
            writable: true,
            linkTarget: null,
            revision: "e1:next",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 200,
        hasMore: false,
        snapshotId: "snapshot-next",
      },
    }),
  );
  await page.route("**/api/sessions/links/files/explorer/preview?**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path !== "docs/next.txt") return route.fallback();
    nextStarted.resolve();
    await nextPreview.promise;
    return route.fulfill({
      json: { path, type: "text", text: "Next preview" },
    });
  });
  await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
  await expect(page.getByRole("button", { name: "Alles kopieren" })).toBeVisible();
  await page.evaluate(() => {
    window.transitionCopySeen = false;
    new MutationObserver(() => {
      if (new URLSearchParams(location.search).get("file") !== "docs/next.txt") return;
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent.trim() === "Alles kopieren",
      );
      if (button) {
        window.transitionCopySeen = true;
        button.click();
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  await page.getByRole("button", { name: "next.txt", exact: true }).click();
  await nextStarted.promise;
  expect(await page.evaluate(() => window.transitionCopySeen)).toBe(false);
  expect(await page.evaluate(() => window.clipboardWrites)).toEqual([]);
  await expect(page.getByRole("button", { name: "Alles kopieren" })).toHaveCount(0);
  nextPreview.resolve();
  await expect(page.getByLabel("Dateivorschau")).toContainText("Next preview");
  await expect(page.getByRole("button", { name: "Alles kopieren" })).toBeVisible();
});

test("pending copy feedback cannot cross a replacement project scope", async ({
  page,
}) => {
  await clipboardFixture(page, "pending");
  const { session } = await fixture(page, "docs/report.md");
  const replacementPreview = deferred();
  const replacementStarted = deferred();
  await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
  const oldButton = page.getByRole("button", { name: "Alles kopieren" });
  await oldButton.click();
  await expect(oldButton).toBeDisabled();

  await page.route("**/api/sessions/links/files/explorer/entries?**", (route) =>
    route.fulfill({
      json: {
        path: "",
        parent: null,
        entries: [
          {
            name: "report.md",
            path: "docs/report.md",
            type: "file",
            size: 36,
            modifiedAt: "2026-09-13T10:00:00.000Z",
            mode: 0o600,
            readable: true,
            writable: true,
            linkTarget: null,
            revision: "e1:replacement",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 200,
        hasMore: false,
        snapshotId: "snapshot-replacement",
      },
    }),
  );
  await page.route("**/api/sessions/links/files/explorer/preview?**", async (route) => {
    if (session.cwd !== "/fixture/replacement") return route.fallback();
    const path = new URL(route.request().url()).searchParams.get("path");
    replacementStarted.resolve();
    await replacementPreview.promise;
    return route.fulfill({
      json: { path, type: "text", text: "Replacement preview" },
    });
  });
  await page.evaluate(() => {
    window.scopeTransitionCopySeen = false;
    new MutationObserver(() => {
      if (!document.body.textContent.includes("/fixture/replacement")) return;
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent.trim() === "Alles kopieren",
      );
      if (button) window.scopeTransitionCopySeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  session.cwd = "/fixture/replacement";
  const replacementEntry = page.getByRole("button", {
    name: "report.md",
    exact: true,
  });
  await expect(replacementEntry).toBeVisible({ timeout: 7000 });
  expect(await page.evaluate(() => window.scopeTransitionCopySeen)).toBe(false);
  await replacementEntry.click();
  await replacementStarted.promise;
  await expect(page.getByRole("button", { name: "Alles kopieren" })).toHaveCount(0);
  replacementPreview.resolve();

  const replacement = page.getByLabel("Dateivorschau");
  await expect(replacement).toContainText("docs/report.md");
  await expect(replacement).toContainText("Replacement preview");
  const replacementButton = replacement.getByRole("button", {
    name: "Alles kopieren",
  });
  await expect(replacementButton).toBeEnabled();
  await replacementButton.click();
  await expect(replacementButton).toBeDisabled();
  await page.evaluate(() => window.completeClipboardWrite());
  await expect.poll(() => page.evaluate(() => window.clipboardWrites.length)).toBe(1);
  await expect(replacement.getByRole("status")).toHaveCount(0);
  await expect(replacement.getByRole("alert")).toHaveCount(0);
  await expect(replacementButton).toBeDisabled();
  await page.evaluate(() => window.completeClipboardWrite());
  await expect.poll(() => page.evaluate(() => window.clipboardWrites.length)).toBe(2);
  await expect(replacement.getByRole("status")).toHaveText(
    "In die Zwischenablage kopiert.",
  );
  await expect(replacementButton).toBeEnabled();
});
