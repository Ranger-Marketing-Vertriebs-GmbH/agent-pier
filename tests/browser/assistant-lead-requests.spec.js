import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

// A lead ("home") with a permanent member it created (Scout), a finished temporary
// member (Researcher), and an archived lead whose permanent member (Keeper) is now a
// root agent. The lead asked and delegated; requests never wait for the owner, and
// only a task the owner asked for in plain words may write.
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
    finished: "Finished (2)",
    question: "Question for Scout",
    task: "Task for Scout",
    mayWrite: "may write",
    readOnly: "read-only",
    answered: "Answered",
    answer: "Answer",
  },
  de: {
    show: "Teammitglieder anzeigen (2)",
    permanent: "Dauerhaft",
    temporary: "Temporär",
    from: "von Home assistant",
    list: "Fragen und Aufgaben",
    open: "Offen (2)",
    finished: "Abgeschlossen (2)",
    question: "Frage an Scout",
    task: "Aufgabe für Scout",
    mayWrite: "darf schreiben",
    readOnly: "nur lesen",
    answered: "Beantwortet",
    answer: "Antwort",
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

async function setup(page, language, history) {
  const state = await chatFixture(page, {
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
        hasAnswer: true,
        finishedAt: "2026-10-13T09:01:00.000Z",
      }),
      request("task-1", {
        type: "task",
        phase: "running",
        text: "Draft a migration plan for vendor B.",
        writeAllowed: true,
        ownerRequestQuote: "delegate the migration plan to Scout",
      }),
      request("ask-2", { phase: "queued" }),
      request("task-0", {
        type: "task",
        phase: "completed",
        text: "Collect last year's invoices.",
        writeAllowed: false,
        finishedAt: "2026-10-12T10:00:00.000Z",
      }),
    ],
    ...(history ? { history } : {}),
  });
  // The list carries summaries; a card loads the whole answer when it is opened.
  await page.route(/\/api\/assistant-lead-requests\/ask-1$/, (route) =>
    route.fulfill({
      json: {
        ...state.requests[0],
        answer: "Vendor B costs 40 euros a month.",
      },
    }),
  );
  return state;
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

      test("the lead's chat holds no approval for member requests", async ({ page }) => {
        await setup(page, language);
        await page.goto(baseURL + "/agents/home/chats/dinner");
        await expect(page.locator(".assistant-message").first()).toBeVisible();
        await expect(page.locator(".lead-request-card")).toHaveCount(0);
        await expect(page.locator(".assistant-approval-strip")).toHaveCount(0);
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
        // A task the owner asked for may write; a question has no such label.
        const task = scout.locator(".lead-request-card").filter({ hasText: w.task });
        await expect(task.locator(".lead-request-access")).toHaveText(w.mayWrite);
        const question = scout
          .locator(".lead-request-card")
          .filter({ hasText: w.question });
        await expect(question.locator(".lead-request-access")).toHaveCount(0);
        await list.evaluate((e) => e.scrollIntoView({ block: "start" }));
        await fits(page);
        if (shots && language === "en")
          await page.screenshot({ path: `${shots}/work-open-${label}.png` });
        await list.getByRole("radio", { name: w.finished }).check();
        const researcher = list.getByRole("group", { name: "Researcher" });
        await expect(researcher).toContainText(w.answered);
        await researcher.getByText(w.answer, { exact: true }).click();
        await expect(researcher).toContainText("Vendor B costs 40 euros a month.");
        // A task without the owner's own words ran read-only.
        const finished = list.getByRole("group", { name: "Scout" });
        await expect(finished.locator(".lead-request-access")).toHaveText(w.readOnly);
        if (shots && language === "en")
          await page.screenshot({ path: `${shots}/work-finished-${label}.png` });
      });
    });

test("a long task's whole text replaces its 'Show all' link once loaded", async ({
  page,
}) => {
  const full = "Draft a migration plan. ".repeat(30).trim();
  const summary = request("task-1", {
    type: "task",
    text: Array.from(full).slice(0, 300).join(""),
    truncated: true,
    writeAllowed: false,
  });
  await chatFixture(page, {
    assistants: [
      chatAssistant(),
      memberAgent("scout", "Scout", { lifetime: "permanent" }),
    ],
    conversations: [
      { id: "dinner", assistantId: "home" },
      { id: "scout-chat", assistantId: "scout" },
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
        memberIds: ["scout"],
        lifetime: "task",
        createdAt: "2026-10-12T09:00:00.000Z",
      },
    ],
    members: [memberRecord("scout", "Scout", { lifetime: "permanent" })],
    requests: [summary],
  });
  // The detail is the whole request, which is never truncated.
  await page.route(/\/api\/assistant-lead-requests\/task-1$/, (route) => {
    const { truncated: _truncated, ...rest } = summary;
    return route.fulfill({ json: { ...rest, text: full } });
  });
  await page.goto(baseURL + "/agents/home/settings?tab=work");
  const card = page.locator(".lead-request-card");
  await card.getByRole("button", { name: "Show all" }).click();
  await expect(card.locator(".assistant-approval-task")).toHaveText(full);
  await expect(card.getByRole("button", { name: "Show all" })).toHaveCount(0);
});

// A lead's settings with one request of its permanent member Scout.
async function oneRequest(page, record) {
  await chatFixture(page, {
    assistants: [
      chatAssistant(),
      memberAgent("scout", "Scout", { lifetime: "permanent" }),
    ],
    conversations: [
      { id: "dinner", assistantId: "home" },
      { id: "scout-chat", assistantId: "scout" },
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
        memberIds: ["scout"],
        lifetime: "task",
        createdAt: "2026-10-12T09:00:00.000Z",
      },
    ],
    members: [memberRecord("scout", "Scout", { lifetime: "permanent" })],
    requests: [record],
  });
  await page.goto(baseURL + "/agents/home/settings?tab=work");
  return page.locator(".lead-request-card .lead-request-access");
}

test("a task an autonomous lead started on its own is marked self-initiated", async ({
  page,
}) => {
  const chips = await oneRequest(
    page,
    request("task-1", { type: "task", writeAllowed: true, selfInitiated: true }),
  );
  await expect(chips).toHaveText(["may write", "self-initiated"]);
});

test("a task one of the lead's routines delegated is marked with the routine", async ({
  page,
}) => {
  const chips = await oneRequest(
    page,
    request("task-1", { type: "task", writeAllowed: false, routine: "Morning check" }),
  );
  await expect(chips).toHaveText(["read-only", "Scheduled · Morning check"]);
});

test("a member's hook report is titled as a hook report", async ({ page }) => {
  const chips = await oneRequest(
    page,
    request("report-1", { type: "report", memberHook: "Zabbix" }),
  );
  await expect(chips).toHaveText(["Hook Zabbix"]);
  await expect(
    page.locator(".lead-request-card .assistant-approval-head strong"),
  ).toHaveText("Hook report from Scout");
});

// Learning handed Head Writer a task and reported a problem; the lead's chat holds
// only quiet notes of the exchange and the report's internal turn.
test("the lead sees its members' exchanges and reports", async ({ page }) => {
  const peer = request("peer-1", {
    type: "task",
    phase: "running",
    memberId: "writer",
    memberAssistantId: "writer",
    memberName: "Head Writer",
    fromMemberId: "learning",
    fromName: "Learning",
    resultTo: "lead",
    text: "Turn the vendor notes into a summary.",
    writeAllowed: false,
  });
  const report = request("report-1", {
    type: "report",
    reportKind: "problem",
    phase: "completed",
    memberId: "learning",
    memberAssistantId: "learning",
    memberName: "Learning",
    text: "The vendor API rejects our key.",
    finishedAt: "2026-10-13T09:05:00.000Z",
  });
  const note = (id, phase, type) => ({
    id,
    role: "event",
    event: "peer-request",
    phase,
    type,
    from: "Learning",
    to: "Head Writer",
    timestamp: at.getTime(),
    runId: null,
  });
  await chatFixture(page, {
    assistants: [
      chatAssistant(),
      memberAgent("learning", "Learning", { lifetime: "permanent" }),
      memberAgent("writer", "Head Writer", { lifetime: "permanent" }),
    ],
    conversations: [
      { id: "dinner", assistantId: "home" },
      { id: "learning-chat", assistantId: "learning" },
      { id: "writer-chat", assistantId: "writer" },
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
        memberIds: ["learning", "writer"],
        lifetime: "task",
        createdAt: "2026-10-12T09:00:00.000Z",
      },
    ],
    members: [
      memberRecord("learning", "Learning", { lifetime: "permanent" }),
      memberRecord("writer", "Head Writer", { lifetime: "permanent" }),
    ],
    requests: [peer, report],
    history: {
      messages: [
        { id: "q", role: "user", text: "Ask the team about vendors." },
        note("peer-start:ask", "started", "question"),
        note("peer-end:ask", "completed", "question"),
        { id: "r", role: "event", event: "member-result", timestamp: at.getTime() },
        { id: "a", role: "assistant", text: "Learning hit a problem with the key." },
      ],
      requests: [],
      stale: false,
    },
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  const notes = page.locator("[data-peer-note]");
  await expect(notes).toHaveText([
    "Learning asked Head Writer a question",
    "Head Writer answered Learning",
  ]);
  await expect(
    page
      .locator(".assistant-event")
      .filter({ hasText: "A member's answer arrived. The agent is passing it on." }),
  ).toHaveCount(1);
  await fits(page);
  if (shots) await page.screenshot({ path: `${shots}/peer-notes.png` });
  await page.goto(baseURL + "/agents/home/settings?tab=work");
  const list = page.locator(".agent-member-requests");
  const task = list.locator(".lead-request-card");
  await expect(task.locator("strong")).toHaveText("Learning → Head Writer · task");
  await expect(task.locator(".lead-request-access")).toHaveText([
    "read-only",
    "result to the lead",
  ]);
  await list.evaluate((e) => e.scrollIntoView({ block: "start" }));
  if (shots) await page.screenshot({ path: `${shots}/peer-task.png` });
  await list.getByRole("radio", { name: "Finished (1)" }).check();
  const problem = list.locator(".lead-request-card");
  await expect(problem.locator("strong")).toHaveText("Problem from Learning");
  await expect(problem).toContainText("The vendor API rejects our key.");
  await list.evaluate((e) => e.scrollIntoView({ block: "start" }));
  await fits(page);
  if (shots) await page.screenshot({ path: `${shots}/peer-requests.png` });
});
