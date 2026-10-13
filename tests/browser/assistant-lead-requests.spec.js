import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

// A lead ("home") with a permanent member it created (Scout), a finished temporary
// member (Researcher), and an archived lead whose permanent member (Keeper) is now a
// root agent. The lead asked and delegated: one question waits for the owner.
const shots = process.env.LEAD_REQUEST_SHOTS;
const viewports = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 1000 },
};
const words = {
  en: {
    show: "Show team members (2)",
    permanent: "Permanent",
    temporary: "Temporary",
    from: "from Home assistant",
    list: "Questions and tasks",
    open: "Open (2)",
    finished: "Finished (1)",
    question: "Question for Scout",
    task: "Task for Scout",
    approve: "Approve",
    answered: "Answered",
    answer: "Answer",
    waiting: "Waiting for your approval · 1",
  },
  de: {
    show: "Teammitglieder anzeigen (2)",
    permanent: "Dauerhaft",
    temporary: "Temporär",
    from: "von Home assistant",
    list: "Fragen und Aufgaben",
    open: "Offen (2)",
    finished: "Abgeschlossen (1)",
    question: "Frage an Scout",
    task: "Aufgabe für Scout",
    approve: "Freigeben",
    answered: "Beantwortet",
    answer: "Antwort",
    waiting: "Wartet auf deine Freigabe · 1",
  },
};
const memberAgent = (id, name, overrides) =>
  chatAssistant({
    id,
    name,
    teamMemberId: id,
    teamId: "research",
    parentAssistantId: "home",
    lifetime: "task",
    ...overrides,
  });
const memberRecord = (id, name, overrides) => ({
  id,
  kind: "member",
  revision: 1,
  teamId: "research",
  parentAssistantId: "home",
  assistantId: id,
  name,
  role: "Research",
  assignment: `${name} researches vendors`,
  lifetime: "task",
  phase: "completed",
  conversationId: `${id}-chat`,
  ...overrides,
});
const request = (id, overrides) => ({
  id,
  kind: "lead-request",
  revision: 1,
  type: "question",
  parentAssistantId: "home",
  memberId: "scout",
  memberAssistantId: "scout",
  memberName: "Scout",
  leadName: "Home assistant",
  text: "Which vendor did you prefer last week?",
  phase: "queued",
  createdAt: "2026-10-13T09:00:00.000Z",
  ...overrides,
});
const at = new Date();
at.setHours(11, 41, 0, 0);

function setup(page, language, history) {
  return chatFixture(page, {
    language,
    assistants: [
      chatAssistant(),
      memberAgent("scout", "Scout", { lifetime: "permanent" }),
      memberAgent("researcher", "Researcher"),
      chatAssistant({
        id: "old-lead",
        name: "Old lead",
        archivedAt: "2026-10-01T00:00:00.000Z",
      }),
      memberAgent("keeper", "Keeper", {
        teamId: "old",
        parentAssistantId: "old-lead",
        lifetime: "permanent",
      }),
    ],
    conversations: [
      { id: "dinner", assistantId: "home" },
      { id: "scout-chat", assistantId: "scout" },
      { id: "researcher-chat", assistantId: "researcher" },
      { id: "keeper-chat", assistantId: "keeper" },
    ],
    teams: [
      {
        id: "research",
        kind: "team",
        revision: 1,
        parentAssistantId: "home",
        parentConversationId: "dinner",
        objective: "Research hosting vendors",
        phase: "completed",
        status: "completed",
        members: [],
        memberIds: ["scout", "researcher"],
        lifetime: "task",
        createdAt: "2026-10-12T09:00:00.000Z",
      },
    ],
    members: [
      memberRecord("scout", "Scout", { lifetime: "permanent" }),
      memberRecord("researcher", "Researcher"),
      memberRecord("keeper", "Keeper", {
        teamId: "old",
        parentAssistantId: "old-lead",
        lifetime: "permanent",
      }),
    ],
    requests: [
      request("ask-1", {
        phase: "completed",
        memberId: "researcher",
        memberAssistantId: "researcher",
        memberName: "Researcher",
        text: "What did vendor B cost?",
        answer: "Vendor B costs 40 euros a month.",
        finishedAt: "2026-10-13T09:01:00.000Z",
      }),
      request("task-1", {
        type: "task",
        phase: "running",
        text: "Draft a migration plan for vendor B.",
      }),
      request("ask-2", { phase: "awaiting_approval" }),
    ],
    activity: {
      home: {
        state: "waiting",
        reason: "approval",
        label: "team.states.awaiting_approval",
        pendingApprovals: 1,
      },
    },
    ...(history ? { history } : {}),
  });
}
const fits = async (page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
async function sidebar(page, label, language) {
  if (label === "phone")
    await page
      .getByRole("button", {
        name: language === "de" ? "Navigation öffnen" : "Open navigation",
        exact: true,
      })
      .click();
  return page.locator(".assistant-chats-group");
}

for (const language of ["en", "de"])
  for (const [label, viewport] of Object.entries(viewports))
    test.describe(`lead requests (${language}, ${label})`, () => {
      const w = words[language];
      test.beforeEach(({ page }) => page.setViewportSize(viewport));

      test("a promoted member stays under its lead in its own section", async ({
        page,
      }) => {
        await setup(page, language);
        await page.goto(baseURL + "/agents/home/chats/dinner");
        const group = await sidebar(page, label, language);
        // Keeper's lead is archived: Keeper is a root agent; Scout is not.
        const rows = group.locator(".assistant-sidebar-row");
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(1)).toContainText("Keeper");
        await group.getByRole("button", { name: w.show }).click();
        const permanent = group.getByRole("group", { name: w.permanent, exact: true });
        await expect(permanent.locator(".assistant-sidebar-member")).toHaveCount(1);
        await expect(permanent).toContainText("Scout");
        await expect(group.locator(".assistant-sidebar-section")).toHaveText([
          w.permanent,
          w.temporary,
        ]);
        const temporary = group.getByRole("group", { name: "Research hosting vendors" });
        await expect(temporary).toContainText("Researcher");
        await expect(temporary).not.toContainText("Scout");
        await fits(page);
        if (shots && language === "en")
          await page.screenshot({ path: `${shots}/sidebar-${label}.png` });
        // The unfolded lead stays unfolded after a reload (#261).
        await page.reload();
        const again = await sidebar(page, label, language);
        await expect(
          again.getByRole("group", { name: w.permanent, exact: true }),
        ).toContainText("Scout");
      });

      test("a member's chat marks its lead's question", async ({ page }) => {
        await setup(page, language, {
          messages: [
            {
              id: "q",
              role: "user",
              text: "Which vendor did you prefer last week?",
              source: "lead",
              sender: { kind: "agent", name: "Home assistant" },
              timestamp: at.getTime(),
            },
            {
              id: "a",
              role: "assistant",
              text: "Vendor B, because it was cheapest.",
              timestamp: at.getTime(),
            },
          ],
          requests: [],
          stale: false,
        });
        await page.goto(baseURL + "/agents/scout/chats/scout-chat");
        const turn = page.locator(".assistant-turn").filter({ hasText: "prefer" });
        const meta = turn.locator(".assistant-message-meta");
        await expect(meta.locator('[aria-hidden="true"]')).toContainText(w.from);
        await expect(turn.locator(".assistant-message")).toHaveAccessibleDescription(
          new RegExp(`^${w.from}, `),
        );
        // The bubble names the lead, never the owner, for screen readers.
        await expect(turn.locator(".assistant-message > strong")).toHaveText(
          "Home assistant",
        );
        await fits(page);
        if (shots && language === "en")
          await page.screenshot({ path: `${shots}/member-chat-${label}.png` });
      });

      test("the lead's chat asks the owner about an agent-initiated question", async ({
        page,
      }) => {
        const state = await setup(page, language);
        await page.goto(baseURL + "/agents/home/chats/dinner");
        await expect(page.locator(".assistant-approval-strip")).toContainText(w.waiting);
        const card = page.locator(".lead-request-card[data-pending]");
        await expect(card).toHaveCount(1);
        await expect(card).toContainText(w.question);
        await expect(card).toContainText("Which vendor did you prefer last week?");
        await card.scrollIntoViewIfNeeded();
        await fits(page);
        if (shots && language === "en")
          await page.screenshot({ path: `${shots}/approval-${label}.png` });
        await card.getByRole("button", { name: w.approve, exact: true }).click();
        await expect
          .poll(() => state.calls)
          .toContain("/api/assistant-lead-requests/ask-2/decision");
      });

      test("Settings → Work → Teams lists questions and tasks per member", async ({
        page,
      }) => {
        await setup(page, language);
        await page.goto(baseURL + "/agents/home/settings?tab=work");
        const list = page.locator(".agent-member-requests");
        await expect(list.getByRole("radio", { name: w.open })).toBeChecked();
        await expect(list.locator(".lead-request-card")).toHaveCount(2);
        const scout = list.getByRole("group", { name: "Scout" });
        await expect(scout).toContainText(w.task);
        await expect(scout).toContainText(w.question);
        await list.evaluate((e) => e.scrollIntoView({ block: "start" }));
        await fits(page);
        if (shots && language === "en")
          await page.screenshot({ path: `${shots}/work-open-${label}.png` });
        await list.getByRole("radio", { name: w.finished }).check();
        const researcher = list.getByRole("group", { name: "Researcher" });
        await expect(researcher).toContainText(w.answered);
        await researcher.getByText(w.answer, { exact: true }).click();
        await expect(researcher).toContainText("Vendor B costs 40 euros a month.");
        if (shots && language === "en")
          await page.screenshot({ path: `${shots}/work-finished-${label}.png` });
      });
    });
