import { test, expect } from "@playwright/test";
import { subagentFixture } from "./subagent-fixture.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

const copy = {
  "de-DE": {
    context: "Kontextbudget",
    assumed: "Angenommenes Fenster (Modell)",
    outputLabel: "Ausgabe",
    output: "≥12.400",
    cost: /^Kosten bei letztem CLI-Ende \(inkl\. Unteragenten\): 1,25\s\$$/,
    subagents: /^Unteragenten: 2 · 1,2\sMio\. Tokens · inkl\. Workflow-Agenten$/,
    row: "12.400 Tokens · 1 min 32 s",
    compaction: "Unterhaltung nach Komprimierung (ohne System/Tools): 41.200",
    stale: "Gespeicherter Stand",
    chip: /^41\s%\sfrei$/,
    showContext: "Kontextdetails anzeigen",
    show: "Unteragenten anzeigen",
    inputCodex: "Eingabe (inkl. Cache)",
    used: /42\s%\sgenutzt/,
    week: "7 Tage",
  },
  "en-GB": {
    context: "Context budget",
    assumed: "Assumed window (model)",
    outputLabel: "Output",
    output: "≥12.4K",
    cost: /^Cost as of last CLI exit \(incl\. subagents\): \$1\.25$/,
    subagents: /^Subagents: 2 · 1\.2M tokens · incl\. workflow agents$/,
    row: "12.4K tokens · 1m 32s",
    compaction: "Conversation after compaction (excl. system/tools): 41.2K",
    stale: "Saved state",
    chip: /^41% left$/,
    showContext: "Show context details",
    show: "Show subagents",
    inputCodex: "Input (incl. cached)",
    used: /42% used/,
    week: "7 days",
  },
};

const claudeObservability = (data) => ({
  ...data.observability,
  context: {
    usedTokens: 590000,
    limitTokens: 1000000,
    remainingPercent: 41,
    source: "last-api-request",
    limitSource: "assumed-model",
    observedAt: "2026-10-01T10:00:00Z",
    modelId: "claude-opus-5-5",
    compaction: null,
  },
  totals: {
    inputTokens: 3200,
    outputTokens: 12400,
    cacheReadTokens: 1180000,
    cacheWriteTokens: 64000,
    reasoningTokens: null,
    totalTokens: 1259600,
    outputIsLowerBound: true,
    cost: { usd: 1.25, scope: "cli-exit-incl-subagents" },
    source: "claude-transcript",
    observedAt: "2026-10-01T10:00:00Z",
    subagents: {
      count: 2,
      inputTokens: 1000,
      outputTokens: 30000,
      cacheReadTokens: 1100000,
      cacheWriteTokens: 69000,
      reasoningTokens: null,
      totalTokens: 1200000,
      outputIsLowerBound: true,
      costUsd: null,
      workflowAgents: 1,
      unavailable: 0,
    },
  },
  limits: null,
  subagents: data.observability.subagents.map((agent) =>
    agent.id === "agentreview01"
      ? {
          ...agent,
          usage: {
            inputTokens: 20,
            outputTokens: 900,
            cacheReadTokens: 11000,
            cacheWriteTokens: 480,
            reasoningTokens: null,
            totalTokens: 12400,
            outputIsLowerBound: true,
            toolUses: 12,
            durationMs: 92000,
            costUsd: null,
          },
        }
      : agent,
  ),
});

async function codexFixture(page, observability) {
  const session = {
    id: "tokens",
    name: "Token session",
    accountId: "local-codex",
    tool: "codex",
    cwd: "/fixture/projects/website",
    status: "running",
    activity: { state: "idle" },
  };
  const data = {
    availability: "ready",
    providerSessionId: "native",
    history: { generation: "one", cursor: null },
    messages: [{ id: "reply", role: "assistant", text: "Done." }],
    tasks: [],
    observability,
  };
  const publish = await mockChatStream(page, () => data);
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "codex", name: "Codex", installed: true }],
          accounts: [{ id: "local-codex", name: "Codex", tool: "codex", kind: "local" }],
          sessions: [session],
          home: "/fixture",
        },
      });
    if (path.endsWith("/chat")) return route.fulfill({ json: data });
    if (path.endsWith("/models"))
      return route.fulfill({
        json: { currentModel: null, picker: null, pending: false },
      });
    throw new Error(`Unexpected token fixture request: ${path}`);
  });
  await page.goto(baseURL + "/sessions/tokens/chat");
  await expect(page.locator(".chat-messages")).toContainText("Done.");
  return { data, publish };
}

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(locale, () => {
    test.use({ locale });
    const text = copy[locale];

    test("Claude shows an assumed window, totals with a lower bound, cost scope and subagent usage", async ({
      page,
    }) => {
      const { data, publish } = await subagentFixture(page);
      data.observability = claudeObservability(data);
      publish();
      const context = page.getByRole("group", { name: text.context });
      await expect(context).toContainText(text.assumed);
      await expect(context.locator(".chat-context-bar")).toBeVisible();
      await page.locator(".chat-token-details > summary").click();
      await expect(
        page.locator(".chat-token-totals tr", { hasText: text.outputLabel }),
      ).toContainText(text.output);
      await expect(page.locator(".chat-token-cost")).toHaveText(text.cost);
      await expect(page.locator(".chat-token-subagents")).toHaveText(text.subagents);
      await expect(
        page.locator('.chat-subagent[data-message-id="toolu_review"] .subagent-usage'),
      ).toHaveText(text.row);
      await page.getByRole("button", { name: text.show }).click();
      await expect(
        page
          .locator(".subagent-entry", { hasText: "Review parser" })
          .locator(".subagent-usage"),
      ).toHaveText(text.row);
      data.observability.stale = true;
      publish();
      await expect(context).toContainText(text.stale);
      await expect(page.locator(".chat-token-cost")).toHaveText(text.cost);
    });

    test("after a compaction only the conversation size is shown, without a bar", async ({
      page,
    }) => {
      const { data, publish } = await subagentFixture(page);
      data.observability = {
        ...data.observability,
        context: {
          usedTokens: null,
          limitTokens: 1000000,
          remainingPercent: null,
          source: null,
          limitSource: "assumed-model",
          observedAt: "2026-10-01T10:05:00Z",
          modelId: "claude-opus-5-5",
          compaction: { conversationTokens: 41200, observedAt: "2026-10-01T10:05:00Z" },
        },
      };
      publish();
      const context = page.getByRole("group", { name: text.context });
      await expect(context).toContainText(text.compaction);
      await expect(context.locator(".chat-context-bar")).toHaveCount(0);
      await expect(context).not.toContainText("%");
    });

    test("Codex shows thread totals without cost and its limit buckets", async ({
      page,
    }) => {
      const resets = Date.now() + 3 * 3600 * 1000;
      await codexFixture(page, {
        context: {
          usedTokens: 70000,
          limitTokens: 272000,
          remainingPercent: 78,
          source: "native-token-count",
          limitSource: "native",
          observedAt: null,
          modelId: "gpt-5.5",
          compaction: null,
        },
        totals: {
          inputTokens: 52000,
          outputTokens: 2000,
          cacheReadTokens: 40000,
          cacheWriteTokens: 0,
          reasoningTokens: 800,
          totalTokens: 54000,
          outputIsLowerBound: false,
          cost: null,
          source: "codex-thread",
          observedAt: null,
          subagents: null,
        },
        limits: {
          source: "codex-rate-limits",
          observedAt: null,
          buckets: [
            {
              limitId: "codex",
              limitName: null,
              plan: "pro",
              windows: [{ windowMinutes: 10080, usedPercent: 42, resetsAt: resets }],
              credits: null,
            },
            {
              limitId: "codex_bengalfox",
              limitName: "GPT-5.3-Codex-Spark",
              plan: null,
              windows: [
                { windowMinutes: 300, usedPercent: 12, resetsAt: resets },
                { windowMinutes: 10080, usedPercent: 3, resetsAt: resets },
              ],
              credits: null,
            },
          ],
        },
        subagents: [],
      });
      await page.locator(".chat-token-details > summary").click();
      await expect(page.locator(".chat-token-totals")).toContainText(text.inputCodex);
      await expect(page.locator(".chat-token-totals")).toContainText("Reasoning");
      await expect(page.locator(".chat-token-cost")).toHaveCount(0);
      const buckets = page.locator(".chat-limit-bucket");
      await expect(buckets).toHaveCount(2);
      await expect(buckets.nth(0)).toContainText(text.week);
      await expect(buckets.nth(0)).toContainText(text.used);
      await expect(buckets.nth(0).locator("time")).toHaveAttribute("title", /\d/);
      await expect(buckets.nth(1)).toContainText("GPT-5.3-Codex-Spark");
      await expect(buckets.nth(1)).toContainText("5 h");
    });

    test("the collapsed mobile row shows only a compact percentage chip", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const { data, publish } = await subagentFixture(page);
      data.observability = claudeObservability(data);
      publish();
      const chip = page.locator(".chat-context-chip");
      await expect(chip).toBeVisible();
      await expect(chip).toHaveText(text.chip);
      await expect(page.locator(".chat-context-budget")).toBeHidden();
      await expect(page.locator(".chat-token-details")).toBeHidden();
      await page.getByRole("button", { name: text.showContext }).click();
      await expect(page.locator(".chat-context-budget")).toBeVisible();
      await expect(chip).toBeHidden();
    });
  });
}
