import { chatAssistant, chatFixture } from "./assistant-chat-fixture.js";

// A lead ("home") with a finished team, a running team, an archived team and a
// proposal, laid out in time around the lead's chat so team notes interleave.
export const at = (seconds) => new Date(Date.UTC(2026, 9, 13, 9, 0, seconds));
const ms = (seconds) => at(seconds).getTime();
const iso = (seconds) => at(seconds).toISOString();

export const teamMessages = () => [
  { id: "ask", role: "user", text: "Plan the relaunch with a team.", timestamp: ms(10) },
  { id: "ok", role: "assistant", text: "I asked a team to research.", timestamp: ms(20) },
  { id: "event", role: "event", event: "team-result", timestamp: ms(60) },
  { id: "summary", role: "assistant", text: "Here is the summary.", timestamp: ms(70) },
];

const member = (id, overrides = {}) => ({
  id,
  kind: "member",
  revision: 1,
  teamId: "research",
  parentAssistantId: "home",
  assistantId: id,
  name: "Researcher",
  role: "Research",
  assignment: "Compare three vendors",
  lifetime: "task",
  phase: "completed",
  conversationId: `${id}-chat`,
  ...overrides,
});

export function teamRecords() {
  const team = (id, overrides) => ({
    id,
    kind: "team",
    revision: 1,
    parentAssistantId: "home",
    parentConversationId: "dinner",
    members: [],
    memberIds: [],
    lifetime: "task",
    archivedAt: null,
    ...overrides,
  });
  return {
    teams: [
      team("old", {
        objective: "Audit last year's site",
        phase: "completed",
        status: "completed",
        archivedAt: iso(5),
        createdAt: iso(1),
        finishedAt: iso(4),
        memberIds: ["old-member"],
      }),
      team("research", {
        objective: "Research hosting vendors",
        phase: "completed",
        status: "completed",
        createdAt: iso(15),
        finishedAt: iso(55),
        memberIds: ["researcher"],
        resultState: "completed",
        resultBatch: [
          {
            memberId: "researcher",
            name: "Researcher",
            role: "Research",
            phase: "completed",
            reportAvailable: true,
            text: "Vendor B is cheapest.",
          },
        ],
        ownerRequestQuote: "Plan the relaunch with a team",
      }),
      team("design", {
        objective: "Draft the new design",
        phase: "running",
        status: "running",
        createdAt: iso(65),
        memberIds: ["designer"],
      }),
      team("proposal", {
        objective: "Write launch copy",
        phase: "awaiting_approval",
        createdAt: iso(80),
        members: [{ name: "Writer", role: "Copy", assignment: "Write the launch post" }],
      }),
    ],
    members: [
      member("old-member", { teamId: "old", name: "Auditor", archivedAt: iso(5) }),
      member("researcher"),
      member("designer", {
        teamId: "design",
        name: "Designer",
        role: "Design",
        assignment: "Sketch the start page",
        phase: "running",
      }),
    ],
  };
}

const memberAgent = (m) =>
  chatAssistant({
    id: m.assistantId,
    name: m.name,
    teamMemberId: m.id,
    teamId: m.teamId,
    parentAssistantId: "home",
    lifetime: "task",
    ...(m.archivedAt ? { archivedAt: m.archivedAt } : {}),
  });

/** The chat fixture with the team records and working team actions. */
export async function teamListFixture(page, options = {}) {
  const records = teamRecords();
  const state = await chatFixture(page, {
    assistants: [chatAssistant(), ...records.members.map(memberAgent)],
    conversations: [
      { id: "dinner", assistantId: "home" },
      ...records.members.map((m) => ({ id: m.conversationId, assistantId: m.id })),
    ],
    history: { messages: teamMessages(), requests: [], stale: false },
    ...records,
    ...options,
  });
  // Archive, restore and decisions change the records like the server would.
  await page.route(/\/api\/assistant-team(s|-proposals)\//, async (route) => {
    const [, kind, id, action] =
      new URL(route.request().url()).pathname
        .replace("/api/", "")
        .match(/^(assistant-teams|assistant-team-proposals)\/([^/]+)\/(\w+)$/) || [];
    const team = state.teams.find((t) => t.id === id);
    if (!kind || !team) return route.fulfill({ status: 404, json: {} });
    state.calls.push(`${kind}/${id}/${action}`);
    if (action === "archive") team.archivedAt = new Date().toISOString();
    if (action === "restore") team.archivedAt = null;
    if (action === "decision") {
      const input = route.request().postDataJSON();
      Object.assign(
        team,
        input.decision === "decline"
          ? { phase: "declined", finishedAt: at(90).toISOString() }
          : { phase: "queued" },
      );
    }
    team.revision += 1;
    return route.fulfill({ json: team });
  });
  return state;
}
