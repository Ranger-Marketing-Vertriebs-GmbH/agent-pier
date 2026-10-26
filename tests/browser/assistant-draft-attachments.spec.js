import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

// A 1×1 PNG: enough for a thumbnail in the composer.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const notFound = {
  error: "Dieser Anhang ist nicht mehr verfügbar. Füge die Datei erneut hinzu.",
  messageKey: "assistants.attachmentNotFound",
};

// The attachment routes of the two chats: uploads by name, the check a returning
// composer makes (`gone` ids are no longer staged), and discards.
async function attachmentRoutes(page, state) {
  state.uploads = [];
  state.kept = [];
  state.deleted = [];
  state.gone = new Set();
  await page.route(
    /\/api\/assistant-conversations\/[^/]+\/(?:attachments|attachment-policy)/,
    async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (url.pathname.endsWith("/attachment-policy"))
        return route.fulfill({
          json: { imageInput: true, maxBytes: 10485760, maxFiles: 5 },
        });
      if (url.pathname.endsWith("/attachments") && method === "POST") {
        const name = url.searchParams.get("name");
        const id = `file-${state.uploads.length + 1}`;
        state.uploads.push({ id, name, path: url.pathname });
        return route.fulfill({
          status: 201,
          json: { id, name, size: png.length, type: "image/png", kind: "image" },
        });
      }
      const id = url.pathname.split("/").at(-1);
      if (method === "DELETE") {
        state.deleted.push(id);
        return route.fulfill({ status: 204, body: "" });
      }
      state.kept.push(id);
      if (state.gone.has(id)) return route.fulfill({ status: 404, json: notFound });
      return route.fulfill({ json: { id, name: "photo.png", size: png.length } });
    },
  );
}

async function open(page, language = "en") {
  const state = await chatFixture(page, {
    language,
    assistants: [chatAssistant(), chatAssistant({ id: "garden", name: "Garden helper" })],
    conversations: [
      { id: "dinner", assistantId: "home" },
      { id: "plants", assistantId: "garden" },
    ],
  });
  await attachmentRoutes(page, state);
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.locator("#assistant-message")).toBeVisible();
  return state;
}

const dropImage = (page) =>
  page.evaluateHandle(
    (bytes) => {
      const carrier = new DataTransfer();
      carrier.items.add(
        new File([new Uint8Array(bytes)], "photo.png", { type: "image/png" }),
      );
      return carrier;
    },
    [...png],
  );
const tray = (page, name = "Attachments") => page.getByRole("list", { name });
const agentButton = (page, name) =>
  page.getByRole("button", { name: new RegExp(`^${name}, `) }).first();

test("a dropped image stays in its chat's composer across agents and settings, then sends", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "File drop is desktop-only; touch devices use the picker.");
  const state = await open(page);
  await page
    .locator(".assistant-chat-panel")
    .dispatchEvent("drop", { dataTransfer: await dropImage(page) });
  await expect(tray(page).getByText("photo.png")).toBeVisible();
  await expect.poll(() => state.uploads.length).toBe(1);
  await page.locator("#assistant-message").fill("What is in this picture?");

  // Another agent's chat shows neither the file nor the text.
  await agentButton(page, "Garden helper").click();
  await expect(page).toHaveURL(/\/agents\/garden/);
  await expect(page.locator("#assistant-message")).toHaveValue("");
  await expect(tray(page)).toHaveCount(0);

  // Back in the first chat, and again after its settings: the draft is all there.
  await agentButton(page, "Home assistant").click();
  await expect(page).toHaveURL(/\/agents\/home/);
  await expect(tray(page).getByText("photo.png")).toBeVisible();
  await expect(tray(page).locator("img")).toHaveCount(1);
  await expect(page.locator("#assistant-message")).toHaveValue(
    "What is in this picture?",
  );
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(tray(page).getByText("photo.png")).toBeVisible();
  expect(state.deleted).toEqual([]);
  await expect.poll(() => state.kept.filter((id) => id === "file-1").length).toBe(2);

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.posted.length).toBe(1);
  expect(state.posted[0].text).toBe("What is in this picture?");
  expect(state.posted[0].attachments).toEqual(["file-1"]);
  await expect(tray(page)).toHaveCount(0);
});

for (const [language, words] of Object.entries({
  en: {
    list: "Attachments",
    gone: "This attachment is no longer available. Add the file again.",
    remove: "Remove photo.png",
    send: "Send",
    settings: "Agent settings",
    back: "Open chat",
  },
  de: {
    list: "Anhänge",
    gone: "Dieser Anhang ist nicht mehr verfügbar. Füge die Datei erneut hinzu.",
    remove: "photo.png entfernen",
    send: "Senden",
    settings: "Agenten-Einstellungen",
    back: "Chat öffnen",
  },
}))
  test(`${language}: a kept file that expired meanwhile says so and can be removed`, async ({
    page,
  }) => {
    const state = await open(page, language);
    await page.locator('input[type="file"]').setInputFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(page.getByRole("button", { name: words.send, exact: true })).toBeEnabled(
      {
        timeout: 10000,
      },
    );
    await page.locator("#assistant-message").fill("Still there?");
    state.gone.add("file-1");
    await page.getByRole("button", { name: words.settings, exact: true }).click();
    await page.getByRole("button", { name: words.back, exact: true }).click();
    await expect(tray(page, words.list).getByRole("alert")).toHaveText(words.gone);
    await expect(
      page.getByRole("button", { name: words.send, exact: true }),
    ).toBeDisabled();
    await tray(page, words.list).getByRole("button", { name: words.remove }).click();
    await expect(tray(page, words.list)).toHaveCount(0);
    expect(state.deleted).toEqual(["file-1"]);
    await page.getByRole("button", { name: words.send, exact: true }).click();
    await expect.poll(() => state.posted.length).toBe(1);
    expect(state.posted[0]).not.toHaveProperty("attachments");
  });
