import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
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
    row: "≥1400 Tokens · 11.000 aus Cache · 1 min 32 s",
    compaction: "Unterhaltung nach Komprimierung (ohne System/Tools): 41.200",
    stale: "Gespeicherter Stand",
    chip: /^41\s%\sverbleibend$/,
    staleChip: /^41\s%\sverbleibendGespeicherter Stand$/,
    window: /Letzte API-Anfrage: 590\.000 \/ 1\sMio\./,
    usedValue: "590.000",
    meter: "codex · pro, 7 Tage",
    process: "Dieser Prozess",
    credits: "Guthaben: 12.50",
    unlimited: "Guthaben: unbegrenzt",
    sessionCost: /^Kosten: 0,0042\s\$$/,
    unavailable: "Unteragenten: 1 · 500 Tokens · 2 nicht verfügbar",
    showContext: "Kontextdetails anzeigen",
    hideContext: "Kontextdetails ausblenden",
    cacheWrite: "Cache geschrieben",
    show: "Unteragenten anzeigen",
    inputCodex: "Eingabe (inkl. Cache)",
    used: /42\s%\sgenutzt/,
    week: "7 Tage",
    reasoningInOutput: "davon Reasoning",
  },
  "en-GB": {
    context: "Context budget",
    assumed: "Assumed window (model)",
    outputLabel: "Output",
    output: "≥12.4K",
    cost: /^Cost as of last CLI exit \(incl\. subagents\): \$1\.25$/,
    subagents: /^Subagents: 2 · 1\.2M tokens · incl\. workflow agents$/,
    row: "≥1.4K tokens · 11K from cache · 1m 32s",
    compaction: "Conversation after compaction (excl. system/tools): 41.2K",
    stale: "Saved state",
    chip: /^41% remaining$/,
    staleChip: /^41% remainingSaved state$/,
    window: /Last API request: 590K \/ 1M/,
    usedValue: "590K",
    meter: "codex · pro, 7 days",
    process: "This process",
    credits: "Credits: 12.50",
    unlimited: "Credits: unlimited",
    sessionCost: /^Cost: \$0\.0042$/,
    unavailable: "Subagents: 1 · 500 tokens · 2 unavailable",
    showContext: "Show context details",
    hideContext: "Hide context details",
    cacheWrite: "Cache write",
    show: "Show subagents",
    inputCodex: "Input (incl. cached)",
    used: /42% used/,
    week: "7 days",
    reasoningInOutput: "of which reasoning",
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

const toolNames = { codex: "Codex", opencode: "OpenCode" };

async function codexFixture(page, observability, tool = "codex") {
  const session = {
    id: "tokens",
    name: "Token session",
    accountId: `local-${tool}`,
    tool,
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
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: tool, name: toolNames[tool], installed: true }],
          accounts: [{ id: `local-${tool}`, name: toolNames[tool], tool, kind: "local" }],
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
      await expect(context).toContainText(text.window);
      expect((await context.textContent()).split(text.usedValue)).toHaveLength(2);
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
      await page.clock.install();
      const resets = Date.now() + 3 * 3600 * 1000;
      const soon = Date.now() + 60 * 1000;
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
                { windowMinutes: 300, usedPercent: 12, resetsAt: soon },
                { windowMinutes: 10080, usedPercent: 3, resetsAt: resets },
              ],
              credits: null,
            },
            {
              limitId: "codex_expired",
              limitName: "Expired",
              plan: null,
              windows: [{ windowMinutes: 300, usedPercent: 90, resetsAt: soon }],
              credits: null,
            },
          ],
        },
        subagents: [],
      });
      await page.locator(".chat-token-details > summary").click();
      await expect(page.locator(".chat-token-totals")).toContainText(text.inputCodex);
      const rows = page.locator(".chat-token-totals tr");
      await expect(rows.nth(1)).toContainText(text.outputLabel);
      await expect(rows.nth(2)).toHaveText(new RegExp(`^${text.reasoningInOutput}800$`));
      await expect(rows.nth(2)).toHaveClass(/sub/);
      await expect(rows).toHaveCount(6);
      await expect(page.locator(".chat-token-cost")).toHaveCount(0);
      const buckets = page.locator(".chat-limit-bucket");
      await expect(buckets).toHaveCount(3);
      await expect(buckets.nth(1).locator(".chat-limit-window")).toHaveCount(2);
      await expect(buckets.nth(0)).toContainText(text.week);
      await expect(buckets.nth(0)).toContainText(text.used);
      await expect(buckets.nth(0).locator("time")).toHaveAttribute("title", /\d/);
      await expect(buckets.nth(1)).toContainText("GPT-5.3-Codex-Spark");
      await expect(buckets.nth(1)).toContainText("5 h");
      await expect(page.getByRole("meter", { name: text.meter })).toBeVisible();
      await expect(page.locator(".chat-token-totals")).not.toContainText(text.process);
      // An open panel hides windows at their reset, without new data.
      await page.clock.fastForward(61 * 1000);
      await expect(buckets).toHaveCount(2);
      await expect(buckets.nth(1).locator(".chat-limit-window")).toHaveCount(1);
    });

    test("process totals, credits, session cost and unavailable subagents are labelled", async ({
      page,
    }) => {
      const totals = (source, extra = {}) => ({
        inputTokens: 900,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: null,
        reasoningTokens: 10,
        totalTokens: 1000,
        outputIsLowerBound: false,
        cost: null,
        source,
        observedAt: null,
        subagents: null,
        ...extra,
      });
      const window = { windowMinutes: 300, usedPercent: 5, resetsAt: null };
      const { data, publish } = await codexFixture(page, {
        context: null,
        totals: totals("codex-process"),
        limits: {
          source: "codex-rate-limits",
          observedAt: null,
          buckets: [
            {
              limitId: "codex",
              limitName: null,
              plan: null,
              windows: [window],
              credits: { hasCredits: true, unlimited: false, balance: "12.50" },
            },
            {
              limitId: "codex_other",
              limitName: null,
              plan: null,
              windows: [window],
              credits: { hasCredits: false, unlimited: true, balance: null },
            },
          ],
        },
        subagents: [],
      });
      await page.locator(".chat-token-details > summary").click();
      await expect(page.locator(".chat-token-totals caption")).toHaveText(text.process);
      await expect(page.locator(".chat-limit-bucket").nth(0)).toContainText(text.credits);
      await expect(page.locator(".chat-limit-bucket").nth(1)).toContainText(
        text.unlimited,
      );
      await expect(page.locator(".chat-token-totals")).not.toContainText(text.cacheWrite);
      data.observability = {
        ...data.observability,
        totals: totals("opencode-session", {
          cost: { usd: 0.0042, scope: "session" },
          subagents: {
            count: 1,
            inputTokens: 400,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 500,
            outputIsLowerBound: false,
            costUsd: null,
            workflowAgents: 0,
            unavailable: 2,
          },
        }),
        limits: null,
      };
      publish();
      await expect(page.locator(".chat-token-cost")).toHaveText(text.sessionCost);
      await expect(page.locator(".chat-token-subagents")).toHaveText(text.unavailable);
      await expect(page.locator(".chat-token-totals caption")).toHaveCount(0);
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
      // The chip is the only visible context value, so it must be readable.
      await expect(chip).not.toHaveAttribute("aria-hidden");
      await expect(page.locator(".chat-context-budget")).toBeHidden();
      await expect(page.locator(".chat-token-details")).toBeHidden();
      await page.getByRole("button", { name: text.showContext }).click();
      await expect(page.locator(".chat-context-budget")).toBeVisible();
      await expect(chip).toBeHidden();
      await page.getByRole("button", { name: text.hideContext }).click();
      await expect(chip).not.toHaveClass(/stale/);
      data.observability.stale = true;
      publish();
      await expect(chip).toHaveClass(/stale/);
      await expect(chip).toHaveText(text.staleChip);
      await expect(chip).toHaveAttribute("title", text.stale);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(0);
    });
  });
}
