import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";

// At 320 px no page scrolls sideways (AGENTPIER-422): Remote access with a long
// Tailscale address, CLIs › Erweiterungen in German, and the hidden chart tables.
test.use({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });

async function expectNoSidewaysScroll(page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.scrollingElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBe(0);
}

test("Settings › Remote access fits 320 px", async ({ page }) => {
  await page.route("**/api/remote", (route) =>
    route.fulfill({
      json: {
        local: { url: "http://127.0.0.1:4380" },
        tailscale: { url: "https://agentpier.tail2788d4.ts.net:8481" },
        network: {
          saved: { enabled: false, bind: "0.0.0.0", hosts: [] },
          running: { enabled: false },
          detected: [],
          urls: [],
          locked: false,
        },
      },
    }),
  );
  await page.goto(baseURL + "/settings/remote");
  await expect(page.getByText("https://agentpier.tail2788d4.ts.net:8481")).toBeVisible();
  const port = page.getByLabel("Erster Port", { exact: true });
  await expect(port).toBeVisible();
  // The whole port number shows.
  expect(await port.evaluate((input) => input.scrollWidth <= input.clientWidth)).toBe(
    true,
  );
  // The bind address select keeps a gap to the next heading.
  const select = await page.getByLabel("Bind-Adresse").boundingBox();
  const heading = await page
    .getByRole("heading", { name: "Zusätzliche Hosts" })
    .boundingBox();
  expect(heading.y - (select.y + select.height)).toBeGreaterThanOrEqual(12);
  await expectNoSidewaysScroll(page);
});

test("Settings › Components with its charts fits 320 px", async ({ page }) => {
  await page.goto(baseURL + "/settings/components");
  const tables = page.locator(".history-chart table, .value-chart table");
  await expect(tables.first()).toBeAttached();
  // A table is never narrower than its content: the screen-reader table sits in a
  // 1 px clipping wrapper, which keeps it from widening the page.
  const wrappers = await tables.evaluateAll((list) =>
    list.map((table) => {
      const wrapper = table.parentElement;
      return (
        wrapper.classList.contains("visually-hidden") &&
        wrapper.getBoundingClientRect().width <= 1 &&
        getComputedStyle(wrapper).overflow === "hidden"
      );
    }),
  );
  expect(wrappers.length).toBeGreaterThan(0);
  expect(wrappers.every(Boolean)).toBe(true);
  await expectNoSidewaysScroll(page);
});

test("a group label with a long German action wraps at 320 px", async ({ page }) => {
  await page.goto(baseURL + "/settings/components");
  const row = page.locator(".group-label-row").first();
  await expect(row).toBeVisible();
  // As CLIs › Erweiterungen shows it on phones: heading, ⓘ and an inline-flex action.
  // Its narrowest width decides how wide its column grows.
  const narrowest = await row.evaluate((element) => {
    element.querySelector("h2, h3, h4").textContent = "Skills und Erweiterungen";
    const action = document.createElement("button");
    action.className = "group-label-action";
    action.style.display = "inline-flex";
    action.style.gap = "4px";
    action.innerHTML = "<span>+</span>Skill installieren";
    element.append(action);
    element.style.width = "min-content";
    return element.getBoundingClientRect().width;
  });
  expect(narrowest).toBeLessThan(180);
});
