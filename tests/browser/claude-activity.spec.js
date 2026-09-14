import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { parseSessionActivity } from "../../server/features/sessions/session-activity.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";

test.use({ locale: "en-GB" });

test("Claude native activity drives English session and chat indicators through background work", async ({
  page,
}) => {
  const activity = (name) =>
    parseSessionActivity(
      "claude",
      JSON.parse(
        readFileSync(
          new URL(`../fixtures/tui-input/${name}.json`, import.meta.url),
          "utf8",
        ),
      ).raw,
    );
  const session = {
    id: "claude-activity",
    name: "Claude activity",
    accountId: "local-claude",
    tool: "claude",
    cwd: "/fixture/project",
    status: "running",
    activity: activity("claude-idle-native"),
  };
  const data = {
    availability: "ready",
    messages: [{ id: "reply", role: "assistant", text: "Checking the project." }],
    tasks: [],
  };
  await mockChatStream(page, () => data);
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "claude", name: "Claude Code", installed: true }],
          accounts: [
            { id: "local-claude", name: "Claude", tool: "claude", kind: "local" },
          ],
          sessions: [session],
          home: "/fixture",
        },
      });
    if (path.endsWith("/chat")) return route.fulfill({ json: data });
    if (path.endsWith("/models"))
      return route.fulfill({
        json: { currentModel: null, picker: null, pending: false },
      });
    throw new Error(`Unexpected Claude activity request: ${path}`);
  });
  await page.goto("/sessions/claude-activity/chat");
  const status = page.getByRole("status", { name: "Session activity" });
  const tab = page.getByRole("button", { name: "Chat", exact: true });
  const row = page.locator(".session-item").filter({ hasText: "Claude activity" });
  await expect(status).toContainText("Ready");
  for (const name of [
    "claude-busy-native",
    "claude-busy-queued-native",
    "claude-background-agent-native",
    "claude-background-shell-native",
  ]) {
    session.activity = activity(name);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(status).toContainText("Working");
    await expect(row).toContainText("Working");
    await expect(status.locator(".chat-working-spinner")).toBeVisible();
    await expect(tab.locator(".chat-working-spinner")).toBeVisible();
  }
  await page.screenshot({ path: "/tmp/agentpier-claude-working-status.png" });
  for (const name of [
    "claude-background-agent-completed-native",
    "claude-background-shell-completed-native",
  ]) {
    session.activity = activity(name);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(status).toContainText("Ready");
    await expect(row).toContainText("Ready");
    await expect(page.locator(".chat-working-spinner")).toHaveCount(0);
  }
});
