import { openNewSession } from "../helpers/navigation.js";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";
import { accountDetail } from "../helpers/accounts-browser.js";

// AnchoredSelect draws its menu in a fixed layer: no card, scroll container or sticky
// bar may clip or cover an option (AGENTPIER-392, AGENTPIER-422).
async function expectOptionsUncovered(page, listbox) {
  await expect(listbox).toBeVisible();
  const covered = await listbox.evaluate((list) => {
    const menu = list.closest(".anchored-options") || list;
    // Scrolled to each end in turn, every option shown is the topmost element.
    const hits = [];
    for (const end of [0, menu.scrollHeight]) {
      menu.scrollTop = end;
      for (const option of list.querySelectorAll('[role="option"]')) {
        const box = option.getBoundingClientRect(),
          view = menu.getBoundingClientRect();
        if (box.bottom <= view.top || box.top >= view.bottom) continue;
        const y = Math.max(box.top, view.top) + 2;
        const hit = document.elementFromPoint(box.left + box.width / 2, y);
        if (!option.contains(hit)) hits.push(option.textContent);
      }
    }
    return hits;
  });
  expect(covered).toEqual([]);
  const box = await listbox.boundingBox();
  // Room for at least three options: the menu is not squeezed into a strip.
  expect(box.height).toBeGreaterThan(110);
}

test("the provider form's API provider list overlays its card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 640 });
  await fixture(page);
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("button", { name: "Provider-Zugang hinzufügen", exact: true })
    .click();
  const dialog = accountDetail(page);
  await dialog.getByLabel("API-Anbieter", { exact: true }).click();
  const list = page.getByRole("listbox", { name: "API-Anbieter: Optionen" });
  await expectOptionsUncovered(page, list);
  await list.getByRole("option", { name: "Z.ai Coding Plan" }).click();
  await expect(dialog.getByLabel("API-Anbieter", { exact: true })).toHaveValue(
    "zai-coding-plan",
  );
  await expect(list).toHaveCount(0);
});

for (const viewport of [
  { width: 1440, height: 700 },
  { width: 390, height: 700 },
]) {
  test(`New session's task profile and sandbox lists clear the dialog actions at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/sandbox-profiles", (route) =>
      route.fulfill({
        json: { available: true, profiles: ["strict", "network", "readonly", "build"] },
      }),
    );
    await page.route("**/api/pipeline-profiles", (route) =>
      route.fulfill({
        json: {
          profiles: ["Review", "Fix", "Docs", "Release"].map((name) => ({
            id: name.toLowerCase(),
            name,
            enabled: true,
            config: {
              accountId: "local-codex",
              cliTool: "codex",
              models: { available: [""], default: "" },
              prompts: { params: [] },
              permissions: { mode: "plan" },
            },
          })),
        },
      }),
    );
    await page.route("**/api/state", (route) =>
      route.fulfill({
        json: {
          tools: [{ id: "codex", installed: true, name: "Codex", path: "/bin/codex" }],
          accounts: [{ id: "local-codex", tool: "codex", name: "Codex", kind: "local" }],
          sessions: [],
          home: "/home/test",
          remoteUrl: null,
        },
      }),
    );
    await page.goto(baseURL);
    await openNewSession(page);
    const dialog = page.getByRole("dialog");
    for (const [name, value] of [
      ["Sandbox-Profil", "build"],
      ["Aufgabenprofil", "release"],
    ]) {
      const field = dialog.getByLabel(name, { exact: true });
      await field.scrollIntoViewIfNeeded();
      await field.click();
      const list = page.getByRole("listbox", { name: `${name}: Optionen` });
      await expectOptionsUncovered(page, list);
      await list.locator('[role="option"]').last().click();
      await expect(field).toHaveValue(value);
    }
  });
}

test("the gallery's SearchSelect opens clear of the sticky save bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/settings/components");
  const trigger = page.getByRole("button", { name: "Suchauswahl", exact: true });
  // Just above the save bar, where an opened panel would end beneath it.
  await trigger.evaluate((element) => {
    const bar = document.querySelector(".save-bar").getBoundingClientRect();
    const box = element.getBoundingClientRect();
    let node = element.parentElement;
    while (
      node &&
      !(
        node.scrollHeight > node.clientHeight &&
        /auto|scroll/.test(getComputedStyle(node).overflowY)
      )
    )
      node = node.parentElement;
    (node || document.scrollingElement).scrollTop += box.bottom - bar.top + 4;
  });
  await trigger.click();
  const panel = page.locator(".search-select-panel");
  await expect(panel).toBeVisible();
  await expect
    .poll(async () => {
      const [box, bar] = await Promise.all([
        panel.boundingBox(),
        page.locator(".save-bar").boundingBox(),
      ]);
      return box.y + box.height <= bar.y;
    })
    .toBe(true);
});
