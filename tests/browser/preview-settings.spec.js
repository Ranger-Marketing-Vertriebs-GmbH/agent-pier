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
    notShared: "Not shared: 47101, 47102, 47103",
    shared: "2 ports shared in your tailnet",
    occupied: /Another Tailscale Serve entry uses 47102/,
    copyCommands: "Copy commands",
  },
  "de-DE": {
    title: "Vorschauen",
    enable: "Vorschauen einschalten",
    first: "Erster Port",
    last: "Letzter Port",
    taken: "Von einem anderen Programm belegt",
    stop: "Beenden",
    save: "Speichern",
    notShared: "Nicht freigegeben: 47101, 47102, 47103",
    shared: "2 Ports im Tailnet freigegeben",
    occupied: /Eine andere Tailscale-Serve-Freigabe nutzt 47102/,
    copyCommands: "Befehle kopieren",
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
  return {
    settings: state.settings,
    previews: state.previews,
    slots,
    serve: state.serve ?? null,
  };
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

const command = "tailscale serve --bg --https=47101 http://127.0.0.1:48101";

for (const locale of ["en-GB", "de-DE"])
  test.describe(`preview Tailscale state ${locale}`, () => {
    test.use({ locale });
    test("shows the shared ports, or the failed ones with the commands to run", async ({
      page,
    }) => {
      const text = copy[locale];
      const state = await previewsFixture(page);
      state.settings = { ...settings, enabled: true };
      state.serve = {
        registered: [47100],
        failed: [
          { port: 47101, reason: "denied" },
          { port: 47102, reason: "occupied" },
          { port: 47103, reason: "denied" },
        ],
        commands: [command],
      };
      await page.goto(baseURL + "/settings/remote");
      const card = page.locator("article", {
        has: page.getByRole("heading", { name: text.title, exact: true }),
      });
      await expect(card.getByText(text.notShared)).toBeVisible();
      await expect(card.getByText(text.occupied)).toBeVisible();
      await expect(card.locator("pre", { hasText: command })).toBeVisible();
      // One line per CLI answer, however many ports it refused.
      await expect(card.getByText("Port 47101, 47103:")).toBeVisible();
      await expect(card.getByRole("button", { name: text.copyCommands })).toBeVisible();
      state.serve = { registered: [47100, 47101], failed: [], commands: [] };
      await page.reload();
      await expect(card.getByText(text.shared)).toBeVisible();
      await expect(card.locator("pre")).toHaveCount(0);
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
