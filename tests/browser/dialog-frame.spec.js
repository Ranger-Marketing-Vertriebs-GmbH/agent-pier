import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

const hosts = Array.from({ length: 12 }, (_, index) => ({
  id: `host-${index}`,
  name: `host-${index}`,
  username: "deploy",
  host: `10.0.0.${index}`,
  port: 22,
}));

async function fixture(page) {
  const state = { puts: [] };
  const session = {
    id: "frame",
    accountId: "local-codex",
    tool: "codex",
    createdAt: "2026-09-09",
    name: "Frame fixture",
    cwd: "/fixture",
    status: "running",
    restartGeneration: 0,
    agentpierTools: {
      enabled: true,
      generation: "fixture",
      selection: {
        scopes: ["catalog:read", "runs:start"],
        projectIds: [],
        accountIds: [],
        connectionIds: [],
        currentProject: true,
      },
    },
  };
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "codex", name: "Codex", installed: true }],
          accounts: [],
          sessions: [session],
          home: "/fixture",
        },
      });
    if (path.endsWith("/ssh-accesses")) {
      if (request.method() === "PUT") state.puts.push(request.postDataJSON());
      return route.fulfill({
        json: {
          tools: { state: "ready" },
          assignedIds: [],
          accesses: hosts,
          commands: [],
        },
      });
    }
    if (path.endsWith("/reload"))
      return route.fulfill({
        json: {
          eligible: true,
          reason: null,
          nativeId: "native-fixture",
          activity: { state: "idle" },
          state: "idle",
          accountTargets: [{ id: "second", name: "Second account" }],
        },
      });
    if (path.endsWith("/chat"))
      return route.fulfill({ json: { availability: "ready", messages: [], tasks: [] } });
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket("**/terminal", (socket) =>
    socket.send(JSON.stringify({ type: "status", status: "running" })),
  );
  await page.goto(baseURL + "/sessions/frame/chat");
  return state;
}

async function openDialog(page, name) {
  await page.getByRole("button", { name, exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("with a fine pointer dialogs focus their first text field, never the close button", async ({
  page,
  browserName,
}) => {
  await fixture(page);
  expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
  const rename = await openDialog(page, "Rename session");
  await expect(rename.getByRole("textbox", { name: "New name" })).toBeFocused();
  await expect(rename.getByRole("button", { name: "Close dialog" })).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(rename).toHaveCount(0);

  // Without a text field the dialog itself takes focus; Tab still reaches controls.
  const tools = await openDialog(page, "AgentPier tools");
  await expect(tools).toBeFocused();
  await expect(tools.getByRole("button", { name: "Close dialog" })).not.toBeFocused();
  // macOS WebKit skips buttons on Tab unless the system setting asks for it.
  if (browserName === "webkit") return;
  await page.keyboard.press("Tab");
  await expect(tools.getByRole("button", { name: "Close dialog" })).toBeFocused();
});

const fieldStyle = (element) =>
  Object.fromEntries(
    ["font-size", "color", "height"].map((key) => [
      key,
      getComputedStyle(element).getPropertyValue(key),
    ]),
  );

test("dialog selects match the text inputs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const rename = await openDialog(page, "Rename session");
  const input = await rename.getByRole("textbox").evaluate(fieldStyle);
  await page.keyboard.press("Escape");
  const switcher = await openDialog(page, "Continue with another account");
  const select = switcher.getByRole("combobox", { name: "Target account" });
  expect(await select.evaluate((element) => getComputedStyle(element).appearance)).toBe(
    "none",
  );
  // The empty choice reads as a placeholder; a chosen account in the input colour.
  expect((await select.evaluate(fieldStyle)).color).not.toBe(input.color);
  await select.selectOption("second");
  expect(await select.evaluate(fieldStyle)).toEqual(input);
});

test("SSH dialog keeps Save visible on a phone with many hosts", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  const dialog = await openDialog(page, "SSH accesses");
  await expect(dialog.getByRole("checkbox")).toHaveCount(hosts.length);
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeInViewport({ ratio: 1 });
  expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0);
  expect(
    await dialog.evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  // The explanation sits behind "Learn more" instead of above the hosts.
  await expect(
    dialog.getByText("They do not isolate processes", { exact: false }),
  ).toBeHidden();
  await expect(dialog.getByRole("heading", { name: "SSH accesses" })).toHaveCount(1);
  await save.click();
  await expect.poll(() => state.puts.length).toBe(1);
});

test("keyboard focus never hides under the sticky header or footer", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await fixture(page);
  const dialog = await openDialog(page, "SSH accesses");
  await expect(dialog.getByRole("checkbox")).toHaveCount(hosts.length);
  const clear = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      const dialog = active.closest("dialog");
      const header = dialog.querySelector(".dialog-heading").getBoundingClientRect();
      const footer = dialog.querySelector(".dialog-actions").getBoundingClientRect();
      const box = active.getBoundingClientRect();
      return box.top >= header.bottom - 1 && box.bottom <= footer.top + 1;
    });
  const boxes = dialog.getByRole("checkbox");
  const visit = async (index, key) => {
    // macOS WebKit does not Tab to checkboxes by default; focus them directly there.
    if (browserName === "webkit") await boxes.nth(index).focus();
    else await page.keyboard.press(key);
    await expect(boxes.nth(index)).toBeFocused();
    expect(await clear(), `host-${index} hidden after ${key}`).toBe(true);
  };
  await boxes.first().focus();
  for (let index = 1; index < hosts.length; index++) await visit(index, "Tab");
  for (let index = hosts.length - 2; index >= 0; index--) await visit(index, "Shift+Tab");
});

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("on touch screens dialogs focus themselves so no keyboard opens", async ({
    page,
  }) => {
    await fixture(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await page.getByRole("button", { name: "Rename session", exact: true }).first().tap();
    const rename = page.getByRole("dialog");
    await expect(rename).toBeFocused();
    await expect(rename.getByRole("textbox", { name: "New name" })).not.toBeFocused();
    await expect(rename.getByRole("button", { name: "Close dialog" })).not.toBeFocused();
  });
  test("tapping anywhere on a check row toggles it", async ({ page }) => {
    await fixture(page);
    const dialog = await openDialog(page, "SSH accesses");
    const box = dialog.getByRole("checkbox", { name: /host-1 / });
    await expect(box).not.toBeChecked();
    await dialog.getByText("deploy@10.0.0.1:22", { exact: true }).tap();
    await expect(box).toBeChecked();
    await dialog.getByText("host-1", { exact: true }).tap();
    await expect(box).not.toBeChecked();
  });
});
