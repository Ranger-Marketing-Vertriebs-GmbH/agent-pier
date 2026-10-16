import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { profile, setup } from "./assistant-shell-fixture.js";
import { setupAssistantSettings } from "../helpers/assistant-settings-browser.js";
import { settingsPath } from "../helpers/agent-settings-page.js";

export const sshAction = (id, extra = {}) => ({
  id,
  revision: 1,
  assistantId: "home",
  state: "awaiting_approval",
  createdAt: "2026-10-16T10:00:00.000Z",
  expiresAt: "2026-10-16T10:10:00.000Z",
  ...extra,
  payload: {
    action: "ssh",
    accessId: "11111111-1111-4111-8111-111111111111",
    hostName: "opnsense",
    host: "opnsense.invalid",
    port: 22,
    username: "root",
    hostFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789",
    projectId: null,
    projectName: null,
    command: "uptime",
    timeoutSeconds: 30,
    originClass: "owner",
    ...extra.payload,
  },
});
export const openChat = (page) => page.goto(baseURL + "/agents/home/chats/chat");
export const sshCard = (page) => page.getByRole("article", { name: "SSH command" });

test("an SSH card shows host, user and the exact command and allows once", async ({
  page,
}) => {
  const state = await setup(page, { actions: [sshAction("a1")] });
  await openChat(page);
  const card = sshCard(page);
  await expect(card).toContainText("opnsense");
  await expect(card).toContainText("root@opnsense.invalid:22");
  await expect(card.locator("pre")).toHaveText("uptime");
  await expect(card).toContainText("Time limit: 30 s");
  await expect(card.getByRole("status")).toHaveAttribute("aria-live", "polite");
  await card.getByRole("button", { name: "Allow once on opnsense" }).click();
  await expect
    .poll(() => state.decisions)
    .toEqual([["a1", { revision: 1, decision: "approve" }]]);
});

test("Deny sends decline", async ({ page }) => {
  const state = await setup(page, { actions: [sshAction("a1")] });
  await openChat(page);
  await sshCard(page).getByRole("button", { name: "Deny on opnsense" }).click();
  await expect
    .poll(() => state.decisions)
    .toEqual([["a1", { revision: 1, decision: "decline" }]]);
});

test("a long command must be shown in full before it can be allowed", async ({
  page,
}) => {
  const command = Array.from({ length: 45 }, (_, n) => `echo line ${n}`).join("\n");
  await setup(page, { actions: [sshAction("a1", { payload: { command } })] });
  await openChat(page);
  const card = sshCard(page);
  const allow = card.getByRole("button", { name: "Allow once on opnsense" });
  await expect(allow).toBeDisabled();
  await expect(card).toContainText("Show the whole command before you allow it.");
  await card.getByRole("button", { name: "Show all" }).click();
  await expect(allow).toBeEnabled();
});

test("hidden characters are shown as codes with a warning", async ({ page }) => {
  await setup(page, {
    actions: [sshAction("a1", { payload: { command: "ls‮ -la" } })],
  });
  await openChat(page);
  const card = sshCard(page);
  await expect(card).toContainText("Contains hidden characters");
  await expect(card.locator("pre")).toContainText("U+202E");
});

test("the lead's chat names the member that asked", async ({ page }) => {
  await setup(page, {
    assistants: [
      {
        ...profile,
        id: "scout",
        name: "Scout",
        teamMemberId: "m1",
        lifetime: "permanent",
        parentAssistantId: "home",
      },
    ],
    actions: [sshAction("a1", { assistantId: "scout", leadAssistantId: "home" })],
  });
  await openChat(page);
  await expect(sshCard(page)).toContainText("Requested by Scout");
});

test("an allowed command shows as running without buttons", async ({ page }) => {
  await setup(page, { actions: [sshAction("a1", { state: "executing", revision: 2 })] });
  await openChat(page);
  const card = sshCard(page);
  await expect(card.getByRole("status")).toContainText("Running");
  await expect(card.getByRole("button", { name: /Allow once/ })).toHaveCount(0);
});

test("the Work tab history lists trusted SSH runs", async ({ page }) => {
  await setupAssistantSettings(page, {
    actions: [
      {
        id: "t1",
        revision: 1,
        assistantId: "home",
        state: "completed",
        createdAt: "2026-10-16T10:00:00.000Z",
        payload: {
          action: "ssh",
          trusted: true,
          hostName: "opnsense",
          commandPreview: "uptime",
        },
        result: { exitCode: 0, durationMs: 1200 },
      },
    ],
  });
  await page.goto(baseURL + settingsPath("work", "actions"));
  await expect(page.getByText("SSH on opnsense · done · 1.2 s")).toBeVisible();
  await expect(page.getByText("Trusted run")).toBeVisible();
});
