import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

// A lead agent with a running four-member team, an open proposal and its team policy.
export async function setup(page) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const parent = {
    id: "home",
    name: "Home assistant",
    instructions: "Original",
    model: { connectionId: "router", modelId: "fixture-model" },
    revision: 1,
    effectiveRevision: 1,
  };
  const members = Array.from({ length: 4 }, (_, n) => ({
    id: `member-${n}`,
    kind: "member",
    assistantId: `member-${n}`,
    parentAssistantId: "home",
    teamId: "team",
    name: `Reviewer ${n + 1}`,
    role: "Research",
    assignment: `Review topic ${n + 1}`,
    phase: "running",
    conversationId: `chat-${n}`,
    revision: 1,
    lifetime: "task",
    inheritedRevision: 1,
  }));
  const team = {
    id: "team",
    kind: "team",
    parentAssistantId: "home",
    objective: "Review the project",
    phase: "running",
    memberIds: members.map((m) => m.id),
    revision: 1,
  };
  const proposal = {
    id: "proposal",
    kind: "team",
    parentAssistantId: "home",
    objective: "Plan a second assignment",
    phase: "awaiting_approval",
    members: [{ name: "Planner", role: "Plan", assignment: "Plan next step" }],
    revision: 1,
  };
  const assistants = [
    parent,
    ...members.map((m) => ({
      ...parent,
      id: m.id,
      name: m.name,
      teamMemberId: m.id,
      parentAssistantId: "home",
      lifetime: "task",
    })),
  ];
  const policy = { revision: 1, autonomous: false, maxMembers: 4, runTimeoutMinutes: 10 };
  const teamSettings = { revision: 1, hostMaxConcurrent: 8 };
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class {
      constructor(url) {
        if (url !== "/api/assistant-events") return new NativeEventSource(url);
        window.assistantTestStream = this;
      }
      close() {}
    };
  });
  const teams = [team, proposal];
  const posted = [];
  const history = {
    messages: [{ id: "reply", role: "assistant", text: "Research in progress" }],
  };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const p = new URL(route.request().url()).pathname,
      method = route.request().method();
    if (
      [
        "/api/assistant-channels",
        "/api/assistant-speech",
        "/api/assistant-runtime/updates",
      ].includes(p)
    )
      return route.fallback();
    if (p === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    let body = {};
    if (p === "/api/assistants")
      body = {
        assistants,
        conversations: [
          { id: "parent-chat", assistantId: "home" },
          ...members
            .filter((m) => m.conversationId)
            .map((m) => ({ id: m.conversationId, assistantId: m.id })),
        ],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        teams,
        members,
        policies: { home: policy },
        teamSettings,
      };
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages")) {
      body = {
        messages: history.messages,
        requests: [],
        stale: false,
      };
      if (method === "POST") posted.push(route.request().postDataJSON());
    } else if (p.endsWith("/conversations")) {
      const id = p.split("/")[3];
      body = {
        id: members.find((m) => m.id === id)?.conversationId || "parent-chat",
        assistantId: id,
      };
    } else if (p.endsWith("/decision")) {
      proposal.phase = "declined";
      body = proposal;
    } else if (p.endsWith("/work") && method === "PUT") {
      const input = route.request().postDataJSON();
      if (input.team) {
        posted.push(input.team);
        if (input.team.revision !== policy.revision)
          return route.fulfill({
            status: 409,
            json: { error: "The data has changed. Please reload." },
          });
        Object.assign(policy, input.team, { revision: policy.revision + 1 });
      }
      body = { access: { revision: 0 }, team: policy };
    } else if (p.endsWith("/access")) {
      body = { revision: 0 };
    } else if (p === "/api/assistant-workspace-catalog") {
      body = { projects: [], pipelines: [] };
    } else if (p.endsWith("/team-policy") || p === "/api/assistant-team-settings") {
      const input = route.request().postDataJSON(),
        current = p.endsWith("/team-policy") ? policy : teamSettings;
      posted.push(input);
      if (input.revision !== current.revision)
        return route.fulfill({
          status: 409,
          json: { error: "The data has changed. Please reload." },
        });
      Object.assign(current, input, { revision: current.revision + 1 });
      body = current;
    } else if (p.endsWith("/archive") || p.endsWith("/restore")) {
      const archivedAt = p.endsWith("/archive") ? "2026-10-08" : null;
      members[0].archivedAt = archivedAt;
      assistants[1].archivedAt = archivedAt;
      body = members[0];
    } else if (method === "PATCH" && p.startsWith("/api/assistants/")) {
      const input = route.request().postDataJSON(),
        agent = assistants.find((a) => a.id === p.split("/")[3]);
      posted.push(input);
      if (input.confirmInstructions) agent.instructionsSource = "owner";
      body = agent;
    } else if (p.endsWith("/promote")) {
      members[0].lifetime = "permanent";
      assistants[1].lifetime = "permanent";
      assistants[1].instructionsSource = "model";
      body = members[0];
    }
    await route.fulfill({ json: body });
  });
  return { members, posted, policy, teamSettings, teams, assistants, history };
}
