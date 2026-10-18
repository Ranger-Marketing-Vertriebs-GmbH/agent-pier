import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

const MB = 1024 * 1024;
const limits = { maxBytes: 1024 * MB, maxFiles: 1000, capped: false };

// The usage and clear routes of the agent's attachments folder, like the server.
async function storageRoutes(page, state) {
  await page.route(/\/api\/assistants\/home\/attachment/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/assistants/home/attachment-usage")
      return route.fulfill({ json: { ...state.usage, ...limits } });
    if (path === "/api/assistants/home/attachments" && request.method() === "DELETE") {
      state.clears++;
      state.usage = { files: 0, bytes: 0 };
      return route.fulfill({ json: { ...state.usage, ...limits } });
    }
    return route.fallback();
  });
}

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("the owner sees the attachment usage and clears it after confirming", async ({
      page,
    }) => {
      await chatFixture(page);
      const state = { clears: 0, usage: { files: 34, bytes: 120 * MB } };
      await storageRoutes(page, state);
      await page.goto(baseURL + settingsPath("profile"));

      const group = page.getByRole("region", { name: "Chat attachments" });
      await expect(group.getByText("120 MB of 1 GB · 34 of 1,000 files")).toBeVisible();

      // Cancel keeps everything.
      await group.getByRole("button", { name: /Clear attachments/ }).click();
      const sheet = page.getByRole("dialog", { name: "Clear this agent's attachments?" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText("120 MB of 1 GB · 34 of 1,000 files")).toBeVisible();
      await sheet.getByRole("button", { name: "Cancel" }).click();
      await expect(sheet).toBeHidden();
      expect(state.clears).toBe(0);

      await group.getByRole("button", { name: /Clear attachments/ }).click();
      await sheet.getByRole("button", { name: "Clear", exact: true }).click();
      await expect.poll(() => state.clears).toBe(1);
      await expect(page.getByRole("status")).toHaveText("Attachments cleared.");
      await expect(group.getByText("0 B of 1 GB · 0 of 1,000 files")).toBeVisible();
      // An empty folder has nothing to clear.
      await expect(
        group.getByRole("button", { name: /Clear attachments/ }),
      ).toBeDisabled();
      if (label === "phone")
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
    });
  });
}

test("a sent file whose copy is gone stays named in its message, without a link", async ({
  page,
}) => {
  await chatFixture(page, {
    history: {
      messages: [
        {
          id: "question",
          role: "user",
          text: "Here is the receipt.",
          attachments: [
            {
              id: "gone",
              name: "receipt.png",
              type: "image/png",
              kind: "image",
              size: 2048,
              unavailable: true,
            },
          ],
        },
        { id: "answer", role: "assistant", text: "Thanks." },
      ],
      requests: [],
      stale: false,
    },
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const files = page.getByRole("list", { name: "Attached files" });
  await expect(files.getByText("receipt.png")).toBeVisible();
  await expect(files.getByText("No longer available")).toBeVisible();
  await expect(files.getByRole("link")).toHaveCount(0);
  await expect(files.locator("img")).toHaveCount(0);
});

test("a folder the agent replaced is explained and restored by clearing", async ({
  page,
}) => {
  await chatFixture(page);
  const state = { clears: 0, usage: { files: 0, bytes: 0, unsafe: true } };
  await storageRoutes(page, state);
  await page.goto(baseURL + settingsPath("profile"));
  const group = page.getByRole("region", { name: "Chat attachments" });
  await expect(
    group.getByText(
      /The agent replaced attachments\/ with something that is not a folder/,
    ),
  ).toBeVisible();
  const clear = group.getByRole("button", { name: /Clear attachments/ });
  await expect(clear).toBeEnabled();
  await clear.click();
  await page
    .getByRole("dialog", { name: "Clear this agent's attachments?" })
    .getByRole("button", { name: "Clear", exact: true })
    .click();
  await expect.poll(() => state.clears).toBe(1);
  await expect(group.getByText("0 B of 1 GB · 0 of 1,000 files")).toBeVisible();
});
