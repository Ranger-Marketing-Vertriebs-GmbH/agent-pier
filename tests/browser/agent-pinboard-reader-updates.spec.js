import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// The pinboard reader while the pinboard changes: a rewritten file shows its new
// version, an entry that turns unavailable keeps its place, every file offers its
// download, a player counts as loaded on its metadata, a failed mark is tried again
// and Back focuses the file read last in its list.
const topic = "agent.pinboard:home";
const entry = (id, name, kind = "text", extra = {}) => ({
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
const list = (id, title, entries) => ({
  id,
  title,
  description: "",
  origin: null,
  archived: false,
  updatedAt: "2026-11-07T10:00:00.000Z",
  entries,
});

// `files(id, version)` answers a file read; `seen` lists the seen POSTs, `failSeen`
// how many of them fail first.
async function open(
  page,
  lists,
  { files = () => ({ body: "# Text" }), failSeen = 0 } = {},
) {
  const state = { lists: structuredClone(lists), seen: [], failSeen };
  await chatFixture(page, { language: "en" });
  await page.route(/\/api\/assistants\/home\/pinboard$/, (route) =>
    route.fulfill({
      json: {
        lists: state.lists,
        fresh: state.lists.flatMap((l) => l.entries).filter((e) => e.fresh).length,
      },
    }),
  );
  await page.route(/\/pinboard\/entries\/([^/]+)\/seen$/, (route) => {
    const id = route.request().url().split("/").at(-2);
    state.seen.push(id);
    if (state.failSeen > 0) {
      state.failSeen--;
      return route.fulfill({ status: 500, json: { error: "Not now" } });
    }
    for (const e of state.lists.flatMap((l) => l.entries))
      if (e.id === id) e.fresh = false;
    return route.fulfill({ status: 204 });
  });
  await page.route(/\/pinboard\/entries\/([^/]+)\/file/, (route) => {
    const url = new URL(route.request().url());
    const { status = 200, body } = files(
      url.pathname.split("/").at(-2),
      url.searchParams.get("v"),
    );
    return route.fulfill({ status, contentType: "application/octet-stream", body });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await page.getByRole("button", { name: /^Pinboard/ }).click();
  return state;
}

const reader = (page) => page.locator(".pinboard-reader");
const entryOf = (state, id) =>
  state.lists.flatMap((l) => l.entries).find((e) => e.id === id);

test("a file rewritten while it is read shows its new version and is marked again", async ({
  page,
  liveStub,
}) => {
  const state = await open(
    page,
    [list("s", "Season", [entry("e6", "ep6.md", "text", { fresh: true })])],
    {
      files: (_id, version) => ({
        body: version === "2" ? "# Episode six, shorter" : "# Episode six",
      }),
    },
  );
  await page.getByRole("button", { name: /ep6\.md/ }).click();
  await expect(reader(page).getByRole("heading", { name: "Episode six" })).toBeVisible();
  await expect.poll(() => state.seen).toEqual(["e6"]);
  Object.assign(entryOf(state, "e6"), { version: 2, fresh: true });
  await liveStub.reread(topic);
  await expect(
    reader(page).getByRole("heading", { name: "Episode six, shorter" }),
  ).toBeVisible();
  await expect.poll(() => state.seen).toEqual(["e6", "e6"]);
});

test("an entry that turns unavailable while it is read keeps previous and next", async ({
  page,
  liveStub,
}) => {
  const state = await open(page, [
    list("s", "Season", [entry("a", "a.md"), entry("b", "b.md"), entry("c", "c.md")]),
  ]);
  await page.getByRole("button", { name: /b\.md/ }).click();
  await expect(reader(page).getByText("Season · 2 of 3")).toBeVisible();
  entryOf(state, "b").state = "unavailable";
  await liveStub.reread(topic);
  await expect(reader(page).getByRole("status")).toHaveText(
    "This file is no longer available.",
  );
  await expect(
    reader(page).getByRole("link", { name: "Download", exact: true }),
  ).toHaveCount(0);
  await expect(reader(page).getByRole("button", { name: /Previous/ })).toBeEnabled();
  await expect(reader(page).getByRole("button", { name: /Next/ })).toBeEnabled();
  await reader(page).getByRole("button", { name: /Next/ }).click();
  // Read from elsewhere, the unavailable entry is skipped.
  await expect(reader(page).getByRole("heading", { name: "c.md" })).toBeVisible();
  await expect(reader(page).getByText("Season · 2 of 2")).toBeVisible();
  await reader(page)
    .getByRole("button", { name: /Previous/ })
    .click();
  await expect(reader(page).getByText("Season · 1 of 2")).toBeVisible();
});

test("every file offers its download, a text that fails to load too", async ({
  page,
}) => {
  await open(
    page,
    [
      list("s", "Season", [
        entry("t", "ep.md"),
        entry("v", "cut.mp4", "video"),
        entry("x", "broken.md"),
      ]),
    ],
    { files: (id) => (id === "x" ? { status: 500, body: "" } : { body: "# Text" }) },
  );
  await page.getByRole("button", { name: /ep\.md/ }).click();
  const download = reader(page).getByRole("link", { name: "Download", exact: true });
  await expect(download).toHaveAttribute("href", /\/entries\/t\/file\?download=1$/);
  await reader(page).getByRole("button", { name: /Next/ }).click();
  await expect(download).toHaveAttribute("href", /\/entries\/v\/file\?download=1$/);
  await reader(page).getByRole("button", { name: /Next/ }).click();
  await expect(reader(page).getByRole("alert")).toBeVisible();
  await expect(
    reader(page).getByRole("link", { name: "Download broken.md" }),
  ).toHaveAttribute("href", /\/entries\/x\/file\?download=1$/);
});

test("a player's metadata marks it seen; a failed mark is tried again on the next open", async ({
  page,
}) => {
  const state = await open(
    page,
    [list("s", "Season", [entry("song", "song.mp3", "audio", { fresh: true })])],
    { failSeen: 1 },
  );
  await page.getByRole("button", { name: /song\.mp3/ }).click();
  await reader(page).locator("audio").dispatchEvent("loadedmetadata");
  await expect.poll(() => state.seen).toEqual(["song"]);
  await reader(page).getByRole("button", { name: "Back to the lists" }).click();
  await page.getByRole("button", { name: /song\.mp3/ }).click();
  await reader(page).locator("audio").dispatchEvent("loadedmetadata");
  await expect.poll(() => state.seen).toEqual(["song", "song"]);
  await expect(page.locator(".pinboard-reader")).toBeVisible();
  await reader(page).getByRole("button", { name: "Back to the lists" }).click();
  await expect(page.locator(".pinboard-entry .status-chip")).toHaveCount(0);
});

test("Back focuses the file read last in its list, among several lists", async ({
  page,
}) => {
  const files = (prefix) =>
    Array.from({ length: 12 }, (_, n) => entry(`${prefix}${n}`, `${prefix} ${n}.md`));
  await open(page, [
    list("one", "First", files("one")),
    list("two", "Second", files("two")),
  ]);
  const panel = page.locator(".docked-panel-body");
  const opened = page.getByRole("button", { name: /two 4\.md/ });
  await opened.scrollIntoViewIfNeeded();
  const top = await panel.evaluate((element) => element.scrollTop);
  await opened.click();
  await reader(page).getByRole("button", { name: /Next/ }).click();
  await expect(reader(page).getByText("Second · 6 of 12")).toBeVisible();
  await reader(page).getByRole("button", { name: "Back to the lists" }).click();
  await expect(page.getByRole("button", { name: /two 5\.md/ })).toBeFocused();
  expect(await panel.evaluate((element) => element.scrollTop)).toBe(top);
});
