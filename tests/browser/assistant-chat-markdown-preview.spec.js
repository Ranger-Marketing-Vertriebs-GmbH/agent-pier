import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";
import { userAppFixture } from "../helpers/user-app-fixture.js";

// A Markdown file an agent shares opens as a rendered preview in a side panel (a
// bottom sheet on phones), fetched from the attachment route without download=1;
// remote images never load, a file over 512 KB says so and keeps the download.
const chat = "/agents/home/chats/dinner";
const file = (id, name, size, type = "text/plain", kind = "text") => ({
  id,
  name,
  type,
  kind,
  size,
});
const notes = [
  "# Weekly plan",
  "",
  "- Buy vegetables",
  "- Cook pasta",
  "",
  "![logo](https://images.example.test/logo.png)",
  "",
  "<img src='https://images.example.test/raw.png'>",
  "",
  "[Recipe](https://recipes.example.test/pasta)",
].join("\n");
const shared = (attachments) => ({
  id: "shared-file:docs",
  role: "assistant",
  text: "Your notes",
  timestamp: 2,
  runId: null,
  shared: true,
  attachments,
});
const files = [
  file("md", "plan.md", Buffer.byteLength(notes)),
  file("big", "archive.md", 600 * 1024),
  file("txt", "notes.txt", 12),
];

function track(page) {
  const seen = { remote: [], attachments: [] };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname.endsWith("example.test")) seen.remote.push(url.href);
    if (/attachments\/[^/]+$/.test(url.pathname))
      seen.attachments.push(`${url.pathname.split("/").at(-1)}${url.search}`);
  });
  return seen;
}

async function serve(page, pattern, { fail = false } = {}) {
  await page.route(pattern, (route) =>
    route.fulfill(
      fail
        ? { status: 500, body: "" }
        : {
            status: 200,
            contentType: "application/octet-stream",
            headers: { "x-content-type-options": "nosniff" },
            body: notes,
          },
    ),
  );
}

async function open(page, options = {}) {
  await chatFixture(page, {
    language: "en",
    history: { messages: [shared(files)], requests: [], stale: false },
  });
  await serve(page, /\/api\/assistant-attachments\//, options);
  const seen = track(page);
  await page.goto(baseURL + chat);
  return { log: page.getByRole("log"), seen };
}

const noSideScroll = async (page, width) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);

for (const [view, use, width] of [
  ["desktop", {}, 1440],
  [
    "phone",
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    390,
  ],
])
  test.describe(view, () => {
    test.use(use);

    test("a Markdown file opens rendered, without remote images, and closes with Escape", async ({
      page,
    }) => {
      const { log, seen } = await open(page);
      const opener = log.getByRole("button", { name: "Preview plan.md" });
      await expect(opener).toBeVisible();
      // Other files stay plain chips with their download.
      await expect(log.getByRole("button", { name: "Preview notes.txt" })).toHaveCount(0);
      await expect(log.getByRole("link", { name: "Download plan.md" })).toHaveAttribute(
        "href",
        /\/api\/assistant-attachments\/md\?download=1$/,
      );

      await opener.focus();
      await page.keyboard.press("Enter");
      const panel = page.getByRole("dialog", { name: "plan.md" });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("heading", { name: "Weekly plan" })).toBeVisible();
      await expect(panel.getByRole("listitem")).toHaveText([
        "Buy vegetables",
        "Cook pasta",
      ]);
      await expect(panel.getByText("[Image: logo]")).toBeVisible();
      await expect(panel.locator("img")).toHaveCount(0);
      await expect(panel.getByRole("link", { name: "Recipe" })).toHaveAttribute(
        "target",
        "_blank",
      );
      const download = panel.getByRole("link", { name: "Download plan.md" });
      await expect(download).toHaveAttribute("download", "plan.md");
      await expect(download).toHaveAttribute("href", /\/md\?download=1$/);
      // Read once from the attachment route, never as a download.
      expect(seen.attachments).toEqual(["md"]);
      expect(seen.remote).toEqual([]);
      await noSideScroll(page, width);
      const box = await panel.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);

      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(opener).toBeFocused();

      // Space opens it as well; the close button closes it.
      await page.keyboard.press(" ");
      await expect(page.getByRole("dialog", { name: "plan.md" })).toBeVisible();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(seen.remote).toEqual([]);
    });

    test("a file over 512 KB offers the download instead", async ({ page }) => {
      const { log, seen } = await open(page);
      await log.getByRole("button", { name: "Preview archive.md" }).click();
      const panel = page.getByRole("dialog", { name: "archive.md" });
      await expect(panel.getByRole("status")).toHaveText(
        "This file is larger than 512 KB, too large for a preview. Download it to read it.",
      );
      await expect(
        panel.getByRole("link", { name: "Download archive.md" }),
      ).toBeVisible();
      expect(seen.attachments).toEqual([]);
      await noSideScroll(page, width);
    });

    test("a preview that fails to load says so and keeps the download", async ({
      page,
    }) => {
      const { log } = await open(page, { fail: true });
      await log.getByRole("button", { name: "Preview plan.md" }).click();
      const panel = page.getByRole("dialog", { name: "plan.md" });
      await expect(panel.getByRole("alert")).toHaveText(
        "The preview could not be loaded. You can still download the file.",
      );
      await expect(panel.getByRole("link", { name: "Download plan.md" })).toBeVisible();
    });
  });

test("a user previews a Markdown file in her own app through her route", async ({
  page,
}) => {
  const state = await userAppFixture(page, {
    language: "en",
    messages: { main: [shared([files[0]])] },
  });
  await serve(page, /\/api\/me\/attachments\//);
  const seen = track(page);
  await page.goto(baseURL + "/agents/lotta/chats/main");
  await page.getByRole("button", { name: "Preview plan.md" }).click();
  const panel = page.getByRole("dialog", { name: "plan.md" });
  await expect(panel.getByRole("heading", { name: "Weekly plan" })).toBeVisible();
  expect(seen.attachments).toEqual(["md"]);
  expect(seen.remote).toEqual([]);
  expect(state.foreign).toEqual([]);
});
