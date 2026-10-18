import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const messages = [
  {
    id: "question",
    role: "user",
    text: "Here is my photo.",
    timestamp: 1,
    attachments: [
      { id: "own", name: "photo.png", type: "image/png", kind: "image", size: 68 },
    ],
  },
  {
    id: "shared-file:img",
    role: "assistant",
    text: "The chart",
    timestamp: 2,
    runId: null,
    shared: true,
    attachments: [
      { id: "img", name: "chart.png", type: "image/png", kind: "image", size: 68 },
      {
        id: "pdf",
        name: "report.pdf",
        type: "application/pdf",
        kind: "document",
        size: 9,
      },
    ],
  },
];
const chat = "/agents/home/chats/dinner";

async function open(page) {
  await chatFixture(page, { history: { messages, requests: [], stale: false } });
  await page.route(/\/api\/assistant-attachments\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png }),
  );
  await page.goto(baseURL + chat);
  return page.getByRole("log");
}

// The home-screen app on an iPhone has no back button, so nothing in the chat may
// navigate away; the specs run in Chromium and WebKit, at a phone's size here.
for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("an image opens in the viewer and closing it returns to the same chat", async ({
      page,
    }) => {
      const log = await open(page);
      for (const name of ["chart.png", "photo.png"]) {
        const opener = log.getByRole("button", { name: `Open ${name}` });
        await opener.click();
        const viewer = page.getByRole("dialog", { name: "Image viewer" });
        await expect(viewer).toBeVisible();
        await expect(viewer.getByRole("img", { name })).toBeVisible();
        // Download saves the file; it never navigates.
        await expect(viewer.getByRole("link", { name: "Download" })).toHaveAttribute(
          "download",
          name,
        );
        await viewer.getByRole("button", { name: "Close image viewer" }).click();
        await expect(viewer).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`${chat}$`));
        await expect(log.getByText("The chart")).toBeVisible();
        // Focus goes back to the image that opened the viewer.
        await expect(opener).toBeFocused();
      }
    });

    test("Esc and a tap beside the image close the viewer", async ({ page }) => {
      const log = await open(page);
      const viewer = page.getByRole("dialog", { name: "Image viewer" });
      await log.getByRole("button", { name: "Open chart.png" }).click();
      await expect(viewer).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(viewer).toHaveCount(0);
      await log.getByRole("button", { name: "Open chart.png" }).click();
      const box = await viewer.boundingBox();
      await page.mouse.click(box.x + 8, box.y + box.height - 8);
      await expect(viewer).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`${chat}$`));
    });

    test("other files download in place", async ({ page }) => {
      const log = await open(page);
      const pdf = log.getByRole("link", { name: "Download report.pdf" });
      await expect(pdf).toHaveAttribute("download", "report.pdf");
      await expect(pdf).not.toHaveAttribute("target", /.+/);
      // No link in the agent's files opens a new page.
      expect(await log.locator(".agent-message-attachments a[target]").count()).toBe(0);
    });
  });
}
