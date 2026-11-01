import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

const settings = { enabled: false, portRangeStart: 47100, portRangeEnd: 47109 };
const copy = {
  "en-GB": {
    title: "Previews",
    enable: "Enable previews",
    first: "First port",
    last: "Last port",
    taken: "Used by another program",
    stop: "Stop",
    save: "Save",
  },
  "de-DE": {
    title: "Vorschauen",
    enable: "Vorschauen einschalten",
    first: "Erster Port",
    last: "Letzter Port",
    taken: "Von einem anderen Programm belegt",
    stop: "Beenden",
    save: "Speichern",
  },
};

function view(state) {
  const { portRangeStart: start, portRangeEnd: end } = state.settings;
  const slots = [];
  for (let port = start; port <= end; port++)
    slots.push({
      port,
      state: state.previews.some((p) => p.slot === port)
        ? "preview"
        : port === start + 1
          ? "taken"
          : "free",
    });
  return { settings: state.settings, previews: state.previews, slots, serve: null };
}

async function previewsFixture(page, { locked = false } = {}) {
  const state = { puts: [], deletes: [], settings, previews: [] };
  const operations = await operationsFixture(page);
  if (locked) operations.remote.network.locked = true;
  await page.route("**/api/previews**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/api/previews/settings" && request.method() === "PUT") {
      state.puts.push(request.postDataJSON());
      state.settings = request.postDataJSON();
      return route.fulfill({ json: view(state) });
    }
    if (pathname === "/api/previews/pv1" && request.method() === "DELETE") {
      state.deletes.push(pathname);
      state.previews = [];
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ json: view(state) });
  });
  return state;
}

const previewRow = {
  id: "pv1",
  slot: 47120,
  target: 5173,
  label: "Shop",
  path: "/",
  owner: { kind: "session", sessionId: "s1" },
  createdAt: "2026-11-01T10:00:00.000Z",
  lastUsedAt: "2026-11-01T10:00:00.000Z",
};

for (const locale of ["en-GB", "de-DE"])
  for (const [name, size] of [
    ["phone", { width: 390, height: 844 }],
    ["desktop", { width: 1280, height: 900 }],
  ])
    test.describe(`preview settings ${locale} ${name}`, () => {
      test.use({ locale });
      test("switch on, set the range, save, see a taken port and stop a preview", async ({
        page,
      }) => {
        const text = copy[locale];
        const state = await previewsFixture(page);
        await page.setViewportSize(size);
        await page.goto(baseURL + "/settings/remote");
        const card = page.locator("article", {
          has: page.getByRole("heading", { name: text.title, exact: true }),
        });
        await expect(card).toBeVisible();
        await card.getByRole("switch", { name: text.enable }).click();
        await card.getByRole("spinbutton", { name: text.first }).fill("47120");
        await card.getByRole("spinbutton", { name: text.last }).fill("47129");
        await card.getByRole("button", { name: text.save }).click();
        await expect
          .poll(() => state.puts)
          .toEqual([{ enabled: true, portRangeStart: 47120, portRangeEnd: 47129 }]);
        await expect(card.getByText(text.taken)).toBeVisible();
        await expect(card.getByText("47121")).toBeVisible();
        if (
          locale === "en-GB" &&
          name === "desktop" &&
          process.env.PREVIEWS_SETTINGS_SCREENSHOT
        ) {
          await card.scrollIntoViewIfNeeded();
          await card.screenshot({ path: process.env.PREVIEWS_SETTINGS_SCREENSHOT });
        }
        state.previews = [previewRow];
        await page.reload();
        await card.getByRole("button", { name: text.stop }).click();
        await expect.poll(() => state.deletes).toEqual(["/api/previews/pv1"]);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
      });
    });

test.describe("plain network access", () => {
  test.use({ locale: "en-GB" });
  test("previews can only be turned off", async ({ page }) => {
    const state = await previewsFixture(page, { locked: true });
    state.settings = { ...settings, enabled: true };
    await page.goto(baseURL + "/settings/remote");
    const card = page.locator("article", {
      has: page.getByRole("heading", { name: "Previews", exact: true }),
    });
    await expect(card.getByText(/can only turn previews off/)).toBeVisible();
    await expect(card.getByRole("spinbutton", { name: "First port" })).toBeDisabled();
    await card.getByRole("switch", { name: "Enable previews" }).click();
    await expect(card.getByRole("switch", { name: "Enable previews" })).toBeDisabled();
    await card.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => state.puts)
      .toEqual([{ enabled: false, portRangeStart: 47100, portRangeEnd: 47109 }]);
  });
});
