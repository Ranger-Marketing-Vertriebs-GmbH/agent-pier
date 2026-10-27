// A busy host for the long-list views (sidebar, start page): 24 sessions in seven
// projects plus one shell, and 14 agents. Plain data, so unit tests and browser
// fixtures share it; tests/helpers/long-lists-browser.js serves it to the app.

const minutesAgo = (minutes, now = Date.now()) =>
  new Date(now - minutes * 60_000).toISOString();

// [name, project, tool, state, minutes in that state].
const running = [
  ["Refactoring Auth", "hoppkit-api", "claude", "working", 14],
  ["API-Rate-Limits", "hoppkit-api", "codex", "idle", 48],
  ["Offline-Karten Tests", "hoppkit-ios", "codex", "working", 22],
  ["Push-Benachrichtigungen", "hoppkit-ios", "claude", "idle", 61],
  ["Onboarding-Flow", "hoppkit-ios", "opencode", "idle", 95],
  ["Kanji-Quiz", "japanischa", "codex", "waiting", 2],
  ["Furigana-Renderer", "japanischa", "claude", "idle", 130],
  ["Systemstatus", "agent-pier", "claude", "working", 3],
  ["Glossar pflegen", "agent-pier", "claude", "idle", 25],
  ["CI-Pipeline", "agent-pier", "codex", "unknown", 40],
  ["Migration prüfen", "bilen-erp", "claude", "waiting", 9],
  ["Rechnungsmodul", "bilen-erp", "claude", "working", 41],
  ["Lager-Ansicht", "bilen-erp", "codex", "idle", 75],
  ["Tilemap-Export", "epochs", "opencode", "working", 6],
  ["Dialog-System", "epochs", "claude", "idle", 88],
  ["Audio-Sprites", "epochs", "codex", "idle", 140],
  ["Heimnetz-Notizen", "homelab", "claude", "idle", 300],
];
const stopped = [
  ["Altes Spike", "hoppkit-api", "codex"],
  ["Release 1.9", "agent-pier", "claude"],
  ["Kana-Tabelle", "japanischa", "claude"],
  ["Export-Test", "bilen-erp", "codex"],
  ["Sprite-Atlas", "epochs", "opencode"],
  ["Router-Backup", "homelab", "claude"],
];

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * 24 sessions: 18 running (2 waiting, 5 working, 9 ready, one shell, one unknown) and
 * 6 stopped.
 */
export function longListSessions() {
  const sessions = running.map(([name, project, tool, state, minutes], index) => ({
    id: `long-${slug(name)}`,
    name,
    tool,
    accountId: `local-${tool}`,
    // Every other project is a repository; the rest are plain folders.
    ...(index % 2 ? { repositoryName: project } : {}),
    cwd: `/work/${project}`,
    status: "running",
    activity: { state, since: minutesAgo(minutes) },
  }));
  sessions.push({
    id: "long-shell",
    name: "Shell",
    tool: "shell",
    accountId: "local-shell",
    cwd: "/work",
    status: "running",
    activity: { state: "terminal", since: minutesAgo(1) },
  });
  for (const [name, project, tool] of stopped)
    sessions.push({
      id: `long-${slug(name)}`,
      name,
      tool,
      accountId: `local-${tool}`,
      cwd: `/work/${project}`,
      status: "stopped",
      activity: { state: "stopped" },
      updatedAt: minutesAgo(600),
    });
  return sessions;
}

const model = { connectionId: "router", modelId: "google/gemini-3.8-flash" };
// [name, activity state, reason]: 2 need you, 3 work, 9 are ready.
const agents = [
  ["Code-Review", "waiting", "approval"],
  ["Buchhaltung", "attention", "attempt"],
  ["Recherche", "working", "attempt"],
  ["Datenpflege", "working", "attempt"],
  ["Support Bilen", "working", "attempt"],
  ["Haushalt"],
  ["Übersetzer"],
  ["Kalender"],
  ["Japanisch-Tutor"],
  ["Mail-Triage"],
  ["Reiseplanung"],
  ["Smart Home"],
  ["Lesezeichen"],
  ["Kochbuch"],
];
const labels = {
  approval: "team.states.awaiting_approval",
  attempt: "status.running",
};

/**
 * 14 root agents for GET /api/assistants: Code-Review leads a team of two, and
 * Support Bilen is shared with a user, so it sits under the users' heading.
 */
export function longListAgents() {
  const assistants = agents.map(([name], index) => ({
    id: `agent-${slug(name)}`,
    name,
    model,
    revision: 1,
    ...(name === "Support Bilen"
      ? {
          userAccess: {
            mode: "shared",
            members: [{ userId: "u-1", level: "chat" }],
            released: [],
          },
        }
      : {}),
    createdAt: minutesAgo(1000 - index),
  }));
  const lead = assistants[0].id;
  const members = ["Prüfer", "Tester"].map((name, index) => ({
    id: `member-${index}`,
    teamId: "team-review",
    assistantId: `agent-member-${slug(name)}`,
    name,
    role: name,
    assignment: "Review the dependency update",
    phase: "running",
    lifetime: "task",
  }));
  for (const member of members)
    assistants.push({
      id: member.assistantId,
      name: member.name,
      model,
      revision: 1,
      teamMemberId: member.id,
      parentAssistantId: lead,
      lifetime: "task",
      teamId: member.teamId,
    });
  const activity = {};
  for (const [name, state, reason] of agents)
    if (state)
      activity[`agent-${slug(name)}`] = {
        state,
        reason,
        label: state === "attention" ? "status.uncertain" : labels[reason],
        pendingApprovals: state === "waiting" ? 1 : 0,
        team: null,
      };
  return {
    assistants,
    conversations: [],
    models: [{ id: "router", name: "OpenRouter", available: true }],
    teams: [
      {
        id: "team-review",
        parentAssistantId: lead,
        objective: "Review the dependency update",
        phase: "running",
        members: [],
        memberIds: members.map((m) => m.id),
      },
    ],
    members,
    policies: {},
    teamSettings: { revision: 0, hostMaxConcurrent: 8 },
    activity,
  };
}
