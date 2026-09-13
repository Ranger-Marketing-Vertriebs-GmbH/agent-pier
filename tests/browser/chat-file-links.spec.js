import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function fixture(
  page,
  target,
  preview = { type: "text", text: "# Acceptance report\nVerified results" },
) {
  const files = [];
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    let json = {};
    if (url.pathname === "/api/state")
      json = {
        tools: [{ id: "codex", name: "Codex", installed: true }],
        accounts: [],
        home: "/fixture",
        sessions: [
          {
            id: "links",
            name: "File links",
            tool: "codex",
            cwd: "/fixture/repo",
            status: "running",
          },
        ],
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
    else if (url.pathname.endsWith("/files/content")) {
      const file = url.searchParams.get("path");
      files.push(file);
      if (file.startsWith("/"))
        return route.fulfill({
          status: 403,
          json: { error: "Datei liegt außerhalb des Projektordners." },
        });
      json = { ...preview, path: file };
    } else if (url.pathname.endsWith("/files"))
      json = { entries: [], total: 0, page: 1, hasMore: false };
    return route.fulfill({ json });
  });
  await page.goto(baseURL + "/sessions/links/chat");
  return files;
}

for (const target of [
  "docs/report.md",
  "/fixture/repo/docs/report.md:12",
  "file:///fixture/repo/docs/report.md#L12",
  "docs/report%20final.md",
]) {
  test(`local chat link opens the project preview: ${target}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const files = await fixture(page, target);
    await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
    await expect(page.getByLabel("Dateivorschau")).toContainText("Verified results");
    expect(files[0]).toBe(
      target.includes("final") ? "docs/report final.md" : "docs/report.md",
    );
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
  await fixture(page, "/outside/report.md");
  await page.getByRole("link", { name: "Abnahmebericht", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("außerhalb des Projektordners");
  await expect(page.getByRole("button", { name: "Alles kopieren" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("npm run build");
});

async function clipboardFixture(page, mode = "success") {
  // Capture writes without replacing the user's system clipboard.
  await page.addInitScript((mode) => {
    window.clipboardWrites = [];
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
                    window.completeClipboardWrite = resolve;
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
        path: `.cache/file-preview-copy-all-${english ? "en-desktop" : "de-mobile"}.png`,
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
  await page.route("**/api/sessions/links/files?**", (route) =>
    route.fulfill({
      json: {
        entries: [{ name: "next.txt", path: "docs/next.txt", type: "file" }],
        total: 1,
        page: 1,
        hasMore: false,
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
