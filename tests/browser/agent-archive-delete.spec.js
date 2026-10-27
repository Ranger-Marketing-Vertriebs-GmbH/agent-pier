import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  emitChange,
  setupAssistantSettings,
} from "../helpers/assistant-settings-browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";

const screenshot = process.env.AGENTPIER_DELETE_SCREENSHOT;

// The owner's archive, restore and permanent delete of an own agent (AGENTPIER-260):
// the ⋯ menu archives it, Agents › Archive lists and restores it, and a delete asks
// for the agent's exact name after listing what is lost.
async function setup(page) {
  const state = await setupAssistantSettings(page);
  state.lifecycle = [];
  await page.route(/\/api\/assistants\/home(\/(archive|restore|deletion))?$/, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON?.() || null;
    const [home] = state.assistants;
    state.lifecycle.push([request.method(), path, body]);
    if (path.endsWith("/archive") || path.endsWith("/restore")) {
      const next = {
        ...home,
        revision: home.revision + 1,
        archivedAt: path.endsWith("/archive") ? "2026-10-27T10:00:00.000Z" : null,
      };
      state.assistants = [next];
      return route.fulfill({ json: next });
    }
    if (path.endsWith("/deletion"))
      return route.fulfill({
        json: {
          id: "home",
          name: "Home",
          counts: {
            chats: 3,
            routines: 2,
            memoryFiles: 4,
            workspaceFiles: 7,
            members: 0,
          },
        },
      });
    if (request.method() === "DELETE") {
      if (body?.name !== "Home") return route.fulfill({ status: 400, json: {} });
      state.assistants = [];
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fallback();
  });
  return state;
}

test("an own agent is archived from its menu, restored and deleted permanently", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + settingsPath());
  await page.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu", { name: "More actions" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Duplicate", "Archive"]);
  await menu.getByRole("menuitem", { name: "Archive" }).click();
  await expect.poll(() => state.assistants[0].archivedAt).toBeTruthy();
  expect(state.lifecycle[0]).toEqual([
    "POST",
    "/api/assistants/home/archive",
    { revision: 1 },
  ]);
  // Agents › Archive lists it with Restore.
  await page.goto(baseURL + "/agents");
  await page.getByRole("button", { name: "Show" }).click();
  const archive = page.locator(".agents-hub-archive");
  await expect(archive.getByText("Home", { exact: true })).toBeVisible();
  await archive.getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => state.assistants[0].archivedAt).toBe(null);
  await emitChange(page);
  await expect(page.locator(".agents-hub-archive")).toHaveCount(0);
  // Archived again, it is deleted from its menu after the name confirmation.
  await page.goto(baseURL + settingsPath());
  await page.getByRole("button", { name: "More actions" }).click();
  await menu.getByRole("menuitem", { name: "Archive" }).click();
  await expect.poll(() => state.assistants[0].archivedAt).toBeTruthy();
  await emitChange(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Duplicate",
    "Restore",
    "Delete permanently",
  ]);
  await menu.getByRole("menuitem", { name: "Delete permanently" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Home permanently?" });
  await expect(dialog).toContainText("3 chats");
  await expect(dialog).toContainText("2 routines, reminders and hooks");
  await expect(dialog).toContainText("4 notes and memory files");
  await expect(dialog).toContainText("7 workspace files");
  const confirm = dialog.getByRole("button", { name: "Delete permanently" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Type “Home” to confirm").fill("home");
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Type “Home” to confirm").fill("Home");
  await expect(confirm).toBeEnabled();
  if (screenshot) await dialog.screenshot({ path: screenshot });
  await confirm.click();
  await expect(page).toHaveURL(/\/agents$/);
  expect(state.lifecycle.at(-1)).toEqual([
    "DELETE",
    "/api/assistants/home",
    { name: "Home" },
  ]);
});
