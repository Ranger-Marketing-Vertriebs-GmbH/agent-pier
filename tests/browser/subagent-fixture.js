import { expect } from "@playwright/test";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

const tool = (id, description, type, status, text, agentId) => ({
  id,
  role: "tool",
  toolName: "Agent",
  status,
  text,
  subagent: { description, type, status, agentId },
});

/** Client time of the fixture: the completed agent finished two seconds ago. */
export const fixtureNow = new Date("2026-09-07T10:00:12Z");

/**
 * A running Claude chat with one completed and one working background subagent.
 * `older` serves an older history page whose subagent row is a frozen snapshot.
 * The page clock starts at `fixtureNow` and stands still once the chat has loaded,
 * so finished agents never expire on a slow run; tests advance it explicitly.
 */
export async function subagentFixture(page, { older = false } = {}) {
  await page.clock.install({ time: fixtureNow });
  const session = {
    id: "subagents",
    name: "Subagent session",
    accountId: "local-claude",
    tool: "claude",
    cwd: "/fixture/projects/website",
    status: "running",
    activity: { state: "working" },
  };
  const data = {
    availability: "ready",
    providerSessionId: "native",
    history: { generation: "one", cursor: older ? "older" : null },
    messages: [
      { id: "prompt", role: "user", text: "Review the parser and the styles" },
      {
        id: "read",
        role: "tool",
        toolName: "Read",
        status: "completed",
        text: '{"file_path":"parser.js"}',
      },
      tool(
        "toolu_review",
        "Review parser",
        "general-purpose",
        "completed",
        "## Parser review\n\nThe parser handles every fixture shape.",
        "agentreview01",
      ),
      tool(
        "toolu_styles",
        "Check styles",
        "Explore",
        "running",
        "Check the stylesheet.",
        "agentstyles02",
      ),
      { id: "reply", role: "assistant", text: "Both reviewers are on it." },
    ],
    tasks: [],
    observability: {
      context: { usedTokens: null, limitTokens: null, source: null },
      subagents: [
        ...(older
          ? [
              {
                id: "agentold03",
                name: "Explore",
                task: "Audit module",
                status: "completed",
                updatedAt: "2026-09-07T09:00:00Z",
              },
            ]
          : []),
        {
          id: "agentreview01",
          name: "general-purpose",
          task: "Review parser",
          status: "completed",
          updatedAt: "2026-09-07T10:00:10Z",
        },
        {
          id: "agentstyles02",
          name: "Explore",
          task: "Check styles",
          status: "running",
          updatedAt: "2026-09-07T10:00:03Z",
        },
      ],
    },
  };
  const publish = await mockChatStream(page, () => data);
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "claude", name: "Claude", installed: true }],
          accounts: [
            { id: "local-claude", name: "Claude", tool: "claude", kind: "local" },
          ],
          sessions: [session],
          home: "/fixture",
        },
      });
    if (path.endsWith("/chat/history"))
      return route.fulfill({
        json: {
          providerSessionId: "native",
          history: { cursor: null },
          messages: [
            { id: "old-prompt", role: "user", text: "Audit the old module" },
            tool(
              "toolu_old",
              "Audit module",
              "Explore",
              "running",
              "Audit it.",
              "agentold03",
            ),
          ],
        },
      });
    if (path.endsWith("/chat")) return route.fulfill({ json: data });
    if (path.endsWith("/models"))
      return route.fulfill({
        json: { currentModel: null, picker: null, pending: false },
      });
    throw new Error(`Unexpected subagent fixture request: ${path}`);
  });
  await page.goto(baseURL + "/sessions/subagents/chat");
  await expect(page.locator(".chat-messages")).toContainText("Both reviewers are on it.");
  const loaded = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(loaded + 10));
  return { session, data, publish };
}
