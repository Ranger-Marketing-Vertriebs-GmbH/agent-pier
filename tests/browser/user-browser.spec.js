import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { userAgent, userAppFixture } from "../helpers/user-app-fixture.js";

// A user's view of her agent's browser at 390px (user-scope.js decides who watches).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////" +
    "////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAA" +
    "AAAAAP/aAAgBAQABPxA=",
  "base64",
);
function frame() {
  const header = Buffer.from(
    JSON.stringify({ url: "https://shop.example/", cssWidth: 800 }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, jpeg]);
}

async function stream(page) {
  const commands = [];
  await page.routeWebSocket("**/api/assistants/family/browser-stream*", (ws) => {
    const state = (control) =>
      ws.send(
        JSON.stringify({
          type: "state",
          state: { status: "live", url: "https://shop.example/", tabs: [], control },
        }),
      );
    ws.onMessage((message) => {
      const command = JSON.parse(message);
      commands.push(command);
      if (command.type === "take") state({ held: true, mine: true, warning: false });
    });
    state({ held: false, mine: false });
    ws.send(frame());
  });
  return commands;
}

const family = userAgent({ id: "family", name: "Family", shared: true });
const languages = {
  de: {
    takeOver: "Übernehmen",
    mine: /Du steuerst den Browser/,
    unavailable: /arbeitet gerade für jemand anderen/,
  },
  en: {
    takeOver: "Take over",
    mine: /You control the browser/,
    unavailable: /working for someone else right now/,
  },
};

for (const [language, copy] of Object.entries(languages))
  test.describe(language, () => {
    test("the driving user sees the live view and can take over", async ({ page }) => {
      const state = await userAppFixture(page, {
        language,
        agents: [family],
        browser: { family: { running: true, watchable: true } },
      });
      const commands = await stream(page);
      await page.goto(baseURL + "/agents/family/browser");
      await expect(
        page.getByText("https://shop.example/", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: copy.takeOver, exact: true }).click();
      await expect(page.getByText(copy.mine)).toBeVisible();
      expect(commands).toContainEqual({ type: "take" });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      expect(state.foreign).toEqual([]);
    });

    test("another user sees 'not available'", async ({ page }) => {
      await userAppFixture(page, {
        language,
        agents: [family],
        browser: { family: { running: true, watchable: false } },
      });
      const commands = await stream(page);
      await page.goto(baseURL + "/agents/family/browser");
      await expect(page.getByText(copy.unavailable)).toBeVisible();
      await expect(page.getByRole("button", { name: copy.takeOver })).toHaveCount(0);
      expect(commands).toEqual([]);
    });
  });
