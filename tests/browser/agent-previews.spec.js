// The previews an agent opened for a chat (agentpier_preview) as a strip under the
// agent chat's header: only in the chat that owns them.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

const preview = {
  id: "pv1",
  slot: 47100,
  target: 5173,
  label: "Shop start page",
  path: "/cart",
  owner: { kind: "agent", assistantId: "home", conversationId: "dinner" },
  createdAt: "2026-11-01T10:00:00.000Z",
  lastUsedAt: "2026-11-01T10:00:00.000Z",
};
const copy = {
  en: { title: "Previews", open: "Open preview", stop: "Stop" },
  de: { title: "Vorschauen", open: "Vorschau öffnen", stop: "Beenden" },
};

async function fixture(page, language) {
  const state = await chatFixture(page, {
    language,
    conversations: [
      { id: "dinner", assistantId: "home" },
      { id: "lunch", assistantId: "home" },
    ],
  });
  state.previews = [preview];
  state.deletes = [];
  await page.route("**/api/previews**", (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/api/previews/pv1" && request.method() === "DELETE") {
      state.deletes.push(pathname);
      state.previews = [];
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({
      json: { settings: {}, previews: state.previews, slots: [], serve: null },
    });
  });
  return state;
}

for (const language of ["en", "de"])
  test(`an agent chat shows its previews as a strip and stops one (${language})`, async ({
    page,
  }) => {
    const text = copy[language];
    const state = await fixture(page, language);
    await page.goto(baseURL + "/agents/home/chats/dinner");
    const strip = page.locator(".agent-preview-strip");
    await expect(strip).toHaveAttribute("aria-label", text.title);
    await expect(strip).toContainText("Shop start page");
    await expect(strip).toContainText("Port 5173");
    const link = strip.getByRole("link", { name: text.open });
    await expect(link).toHaveAttribute("href", "http://127.0.0.1:47100/cart");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    if (language === "en" && process.env.PREVIEWS_SCREENSHOT)
      await page.screenshot({ path: process.env.PREVIEWS_SCREENSHOT });
    await strip.getByRole("button", { name: text.stop }).click();
    await expect.poll(() => state.deletes).toEqual(["/api/previews/pv1"]);
    await expect(page.locator(".agent-preview-strip")).toHaveCount(0);
  });

test("another chat of the agent shows no preview strip", async ({ page }) => {
  await fixture(page, "en");
  await page.goto(baseURL + "/agents/home/chats/lunch");
  await expect(page.getByText("We can plan dinner together.")).toBeVisible();
  await expect(page.locator(".agent-preview-strip")).toHaveCount(0);
});
