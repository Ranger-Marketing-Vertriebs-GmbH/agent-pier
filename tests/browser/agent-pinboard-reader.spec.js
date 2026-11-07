import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// The pinboard reader: a pinned file read in full with previous / next, Markdown
// rendered like the chat's preview (no raw HTML, no remote images, 512 KB cap).
const notes = [
  "# Episode six",
  "",
  "![x](https://images.example.test/x.png)",
  "",
  "<img src='https://images.example.test/raw.png'>",
].join("\n");
const entry = (id, name, kind, extra = {}) => ({
  id,
  name,
  note: "",
  version: 1,
  kind,
  size: 100,
  state: "ok",
  fresh: false,
  ...extra,
});
const list = {
  id: "season",
  title: "Season 2",
  description: "",
  origin: null,
  archived: false,
  updatedAt: "2026-11-07T10:00:00.000Z",
  entries: [
    entry("e6", "ep6.md", "text", { fresh: true, size: Buffer.byteLength(notes) }),
    entry("gone", "gone.md", "text", { state: "unavailable" }),
    entry("cut", "cut.mp4", "video"),
    entry("big", "big.md", "text", { size: 600 * 1024 }),
  ],
};
const media = [
  entry("pic", "pic.png", "image", { fresh: true }),
  entry("zip", "data.zip", "file"),
  entry("song", "song.mp3", "audio"),
];

async function open(page, { entries = list.entries } = {}) {
  const state = { entries: structuredClone(entries), seen: [], files: [], remote: [] };
  await chatFixture(page, { language: "en" });
  await page.route(/\/api\/assistants\/home\/pinboard$/, (route) =>
    route.fulfill({
      json: {
        lists: [{ ...list, entries: state.entries }],
        fresh: state.entries.filter((e) => e.fresh).length,
      },
    }),
  );
  await page.route(/\/pinboard\/entries\/([^/]+)\/seen$/, (route) => {
    const id = route.request().url().split("/").at(-2);
    state.seen.push(id);
    for (const e of state.entries) if (e.id === id) e.fresh = false;
    return route.fulfill({ json: {} });
  });
  await page.route(/\/pinboard\/entries\/([^/]+)\/file/, (route) => {
    const url = new URL(route.request().url());
    state.files.push(`${url.pathname.split("/").at(-2)}${url.search}`);
    return route.fulfill({
      contentType: "application/octet-stream",
      headers: { "x-content-type-options": "nosniff" },
      body: notes,
    });
  });
  page.on("request", (request) => {
    if (new URL(request.url()).hostname.endsWith("example.test"))
      state.remote.push(request.url());
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  return state;
}

async function showPinboard(page, phone) {
  if (phone) await page.getByRole("radio", { name: /Pinboard/ }).check({ force: true });
  else await page.getByRole("button", { name: /^Pinboard/ }).click();
}

for (const [view, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
])
  test.describe(view, () => {
    test.use(use);
    const phone = view === "phone";

    test("reads Markdown, steps through the list and marks NEW entries seen once", async ({
      page,
    }) => {
      const state = await open(page);
      await showPinboard(page, phone);
      await expect(page.locator(".pinboard-entry .status-chip")).toBeVisible();
      await page.getByRole("button", { name: /ep6\.md/ }).click();

      const reader = page.locator(".pinboard-reader");
      await expect(reader.getByRole("heading", { name: "ep6.md" })).toBeVisible();
      await expect(reader.getByText("Season 2 · 1 of 3")).toBeVisible();
      // The reader fills the pinboard area, whose lists it replaced.
      const area = await page
        .locator(phone ? ".assistant-pinboard-tab" : ".docked-panel-body")
        .boundingBox();
      const box = await reader.boundingBox();
      expect(box.width).toBeGreaterThan(area.width - 40);
      expect(box.height).toBeGreaterThan(area.height - 40);
      await expect(reader.getByRole("heading", { name: "Episode six" })).toBeVisible();
      await expect(reader.locator("img")).toHaveCount(0);
      await expect.poll(() => state.seen).toEqual(["e6"]);
      expect(state.remote).toEqual([]);
      const previous = reader.getByRole("button", { name: /Previous/ });
      await expect(previous).toBeDisabled();

      // The unavailable entry is skipped.
      await reader.getByRole("button", { name: /Next/ }).click();
      await expect(reader.getByText("Season 2 · 2 of 3")).toBeVisible();
      await expect(reader.locator("video")).toHaveAttribute(
        "src",
        /\/entries\/cut\/file/,
      );
      await reader.locator("video").dispatchEvent("loadeddata");
      await previous.click();
      await expect(reader.getByRole("heading", { name: "ep6.md" })).toBeVisible();
      await reader.getByRole("button", { name: /Next/ }).click();
      await reader.locator("video").dispatchEvent("loadeddata");
      await reader.getByRole("button", { name: /Next/ }).click();

      // Over 512 KB: a notice and the download, nothing fetched.
      await expect(reader.getByText("Season 2 · 3 of 3")).toBeVisible();
      await expect(reader.getByRole("status")).toContainText("too large");
      await expect(reader.getByRole("link", { name: "Download big.md" })).toHaveAttribute(
        "href",
        /\/entries\/big\/file\?download=1$/,
      );
      await expect(reader.getByRole("button", { name: /Next/ })).toBeDisabled();
      expect(state.files.some((file) => file.startsWith("big"))).toBe(false);
      // Only the NEW entry was marked, once, however often it was shown.
      await expect(
        reader.getByRole("link", { name: "Download", exact: true }),
      ).toBeVisible();
      expect(state.seen).toEqual(["e6"]);

      // Back returns to the lists at the same list.
      await reader.getByRole("button", { name: "Back to the lists" }).click();
      await expect(page.locator(".pinboard-reader")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Season 2" })).toBeVisible();
      await expect(page.locator(".pinboard-entry .status-chip")).toHaveCount(0);
    });

    test("shows images, audio and other files", async ({ page }) => {
      const state = await open(page, { entries: media });
      await showPinboard(page, phone);
      await page.getByRole("button", { name: /pic\.png/ }).click();
      const reader = page.locator(".pinboard-reader");
      await expect(reader.getByText("Season 2 · 1 of 3")).toBeVisible();
      await expect(reader.locator("img")).toHaveAttribute(
        "src",
        /\/entries\/pic\/file\?v=1$/,
      );
      await reader.locator("img").evaluate((img) => img.dispatchEvent(new Event("load")));
      await expect.poll(() => state.seen).toEqual(["pic"]);
      await reader.getByRole("button", { name: "Open pic.png" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await reader.getByRole("button", { name: /Next/ }).click();
      await expect(
        reader.getByRole("link", { name: "Download data.zip" }),
      ).toHaveAttribute("href", /\/entries\/zip\/file\?download=1$/);
      // A file that is not NEW is not marked.
      await expect(reader.getByText("Season 2 · 2 of 3")).toBeVisible();
      expect(state.seen).toEqual(["pic"]);
      await reader.getByRole("button", { name: /Next/ }).click();
      await expect(reader.locator("audio")).toHaveAttribute(
        "src",
        /\/entries\/song\/file\?v=1$/,
      );
    });
  });

test.describe("phone full screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the reader fills the screen and Back returns to the list where it was", async ({
    page,
  }) => {
    const many = Array.from({ length: 16 }, (_, n) =>
      entry(`d${n}`, `Draft ${n}.md`, "text"),
    );
    await open(page, { entries: many });
    await showPinboard(page, true);
    const tab = page.locator(".assistant-pinboard-tab");
    const row = page.getByRole("button", { name: /Draft 12\.md/ });
    await row.scrollIntoViewIfNeeded();
    const top = await tab.evaluate((element) => element.scrollTop);
    expect(top).toBeGreaterThan(0);
    await row.click();

    const reader = page.locator(".pinboard-reader");
    await expect(reader.getByRole("heading", { name: "Draft 12.md" })).toBeVisible();
    // The chat's header, its row and the composer give way to the reader's own bar.
    for (const hidden of [
      ".assistant-header",
      ".agent-chat-switch",
      ".assistant-composer",
    ])
      await expect(page.locator(hidden)).toBeHidden();
    const bar = reader.locator(".pinboard-reader-header");
    await expect(bar.getByRole("button", { name: "Back to the lists" })).toBeVisible();
    await expect(bar.getByText("Season 2 · 13 of 16")).toBeVisible();
    await expect(bar.getByRole("link", { name: "Download", exact: true })).toBeVisible();
    const viewport = page.viewportSize();
    expect((await bar.boundingBox()).y).toBeLessThanOrEqual(1);
    const footer = await reader.locator(".pinboard-reader-footer").boundingBox();
    expect(footer.y + footer.height).toBeGreaterThan(viewport.height - 2);
    await reader.getByRole("button", { name: /Next/ }).click();
    await expect(bar.getByText("Season 2 · 14 of 16")).toBeVisible();

    await bar.getByRole("button", { name: "Back to the lists" }).click();
    await expect(reader).toHaveCount(0);
    await expect(page.locator(".assistant-header")).toBeVisible();
    await expect(page.locator(".assistant-composer")).toBeVisible();
    await expect.poll(() => tab.evaluate((element) => element.scrollTop)).toBe(top);
    await expect(page.getByRole("button", { name: /Draft 13\.md/ })).toBeFocused();
  });
});
