import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantAccess } from "../../server/features/assistants/assistant-access.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { compileOpenClawConfig } from "../../server/features/assistants/runtime-config.js";
import { mirrorLeadMemory } from "../../server/features/assistants/member-memory.js";
import { assistantBootstrap } from "../../server/features/assistants/assistant-bootstrap.js";

const model = { connectionId: "c", modelId: "m" };
const everything = {
  memory: true,
  reminders: true,
  webSearch: true,
  webFetch: true,
  browser: true,
  documents: true,
};
const paths = { workspaces: "/data/workspaces", logs: "/data/logs" };
const webTools = {
  search: { provider: "duckduckgo", requiresPlugin: true },
  browser: { available: true, name: "Chrome", executablePath: "/bin/chrome" },
  searchPlugins: {
    duckduckgo: { id: "duckduckgo", directory: "/rt/duckduckgo" },
  },
};

function fixture(t, { memberShellSsh = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-member-inherit-"));
  const store = new AssistantStore({ dataDir });
  const teams = new TeamStore({ store });
  const ledger = new RequestLedger(store.db);
  const access = new AssistantAccess({ assistants: { store } });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const created = store.createAssistant({ name: "Lead", instructions: "Plan", model });
  const lead = store.updateAssistant(
    created.id,
    { capabilities: everything, shell: "approval", skills: ["weather"] },
    created.revision,
  );
  access.write(lead.id, {
    ...access.get(lead.id),
    revision: 1,
    sshAccesses: [{ accessId: "host-1", mode: "approval" }],
  });
  if (memberShellSsh) teams.savePolicy(lead.id, { memberShellSsh: true }, 1);
  const chat = store.saveConversation({
    assistantId: lead.id,
    runtimeSessionKey: "agent:lead:test",
  });
  const request = ledger.accept(chat.id, { clientRequestId: "owner", text: "Team" });
  const proposal = teams.propose({
    operationId: "tool",
    parentAttemptId: ledger.recordAttempt(request.id).id,
    objective: "Review",
    members: [{ name: "Scout", role: "Research", assignment: "Look around" }],
    origin: { kind: "owner" },
  });
  teams.decide(
    proposal.id,
    { revision: proposal.revision, decision: "approve", lifetime: "task" },
    { kind: "owner" },
  );
  const member = store.getAssistant(
    teams.member(teams.reserve(proposal.id).memberIds[0]).assistantId,
  );
  const compile = () => {
    const profiles = store.listAssistants();
    return compileOpenClawConfig({
      existing: {
        agents: {
          defaults: {},
          entries: Object.fromEntries(
            profiles.map((p) => [p.runtimeAgentId, { id: p.runtimeAgentId }]),
          ),
        },
      },
      paths,
      port: 20000,
      token: "gateway-token",
      teams: {
        directory: "/private/plugin",
        connection: { url: "http://127.0.0.1:1235", token: "bridge" },
        hostMaxConcurrent: 4,
        native: { token: "hook" },
        profiles,
        sshAgents: access.sshAgents(),
      },
      webTools,
    });
  };
  return { store, teams, access, lead, member, compile, dataDir };
}

test("a task member's compiled entry carries its lead's web tools, skills and read-only memory", (t) => {
  const f = fixture(t);
  const config = f.compile();
  const entry = config.agents.entries[f.member.runtimeAgentId];
  for (const tool of ["web_search", "web_fetch", "browser", "view_image", "read"])
    assert.ok(entry.tools.allow.includes(tool), tool);
  assert.ok(entry.tools.allow.includes("agentpier_reminder"));
  for (const tool of ["write", "edit", "agentpier_routine", "exec", "agentpier_ssh"])
    assert.ok(!entry.tools.allow.includes(tool), tool);
  assert.ok(!entry.tools.allow.some((tool) => tool.startsWith("agentpier_team_")));
  assert.equal(entry.tools.exec, undefined);
  assert.deepEqual(entry.skills, ["weather"]);
  assert.equal(entry.memory.search.enabled, true);
  // The global network safety stays as the lead's capabilities compile it.
  assert.deepEqual(config.tools.web.fetch, {
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
  });
  assert.equal(f.access.hasSshGrants(f.member.id), false);
});

test("with the lead's setting the member gets the lead's shell level and SSH grants", (t) => {
  const f = fixture(t, { memberShellSsh: true });
  const entry = f.compile().agents.entries[f.member.runtimeAgentId];
  assert.ok(
    entry.tools.allow.includes("exec") && entry.tools.allow.includes("agentpier_ssh"),
  );
  const lead = f.compile().agents.entries[f.lead.runtimeAgentId];
  assert.deepEqual(entry.tools.exec, lead.tools.exec);
  // SSH runs on the lead's grants, never on grants of the member's own.
  assert.equal(f.access.sshHolder(f.member.id).id, f.lead.id);
  assert.deepEqual(f.access.sshGrant(f.member.id, "host-1"), {
    accessId: "host-1",
    mode: "approval",
  });
  // The lead loses its grants: the member's SSH tool and grant go with them.
  f.access.write(f.lead.id, { ...f.access.get(f.lead.id), sshAccesses: [] });
  const after = f.compile().agents.entries[f.member.runtimeAgentId];
  assert.ok(!after.tools.allow.includes("agentpier_ssh"));
  assert.equal(f.access.sshGrant(f.member.id, "host-1"), null);
});

test("without the setting a member's SSH calls find no holder", (t) => {
  const f = fixture(t);
  assert.throws(() => f.access.sshHolder(f.member.id), { status: 403 });
  assert.equal(f.access.sshGrant(f.member.id, "host-1"), null);
});

test("a member's memory is a read-only copy of its lead's, refreshed and removed", async (t) => {
  const f = fixture(t);
  const root = path.join(f.dataDir, "workspaces");
  const lead = path.join(root, f.lead.id),
    own = path.join(root, f.member.id);
  fs.mkdirSync(path.join(lead, "memory", "projects"), { recursive: true });
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(lead, "MEMORY.md"), "Lead facts");
  fs.writeFileSync(path.join(lead, "memory", "projects", "atlas.md"), "Atlas notes");
  fs.writeFileSync(path.join(lead, "memory", "secret.txt"), "not a note");
  await mirrorLeadMemory(root, f.member, true);
  assert.equal(fs.readFileSync(path.join(own, "MEMORY.md"), "utf8"), "Lead facts");
  assert.equal(
    fs.readFileSync(path.join(own, "memory", "projects", "atlas.md"), "utf8"),
    "Atlas notes",
  );
  assert.equal(fs.existsSync(path.join(own, "memory", "secret.txt")), false);
  // Whatever lands in the copy is replaced by the lead's again before the next turn.
  fs.writeFileSync(path.join(own, "MEMORY.md"), "Injected");
  fs.writeFileSync(path.join(own, "memory", "planted.md"), "Planted");
  await mirrorLeadMemory(root, f.member, true);
  assert.equal(fs.readFileSync(path.join(own, "MEMORY.md"), "utf8"), "Lead facts");
  assert.equal(fs.existsSync(path.join(own, "memory", "planted.md")), false);
  assert.equal(fs.readFileSync(path.join(lead, "MEMORY.md"), "utf8"), "Lead facts");
  // Once the member no longer inherits memory, the copy is gone.
  await mirrorLeadMemory(root, f.member, false);
  assert.equal(fs.existsSync(path.join(own, "MEMORY.md")), false);
  assert.equal(fs.existsSync(path.join(own, "memory", "projects", "atlas.md")), false);
  assert.match(
    assistantBootstrap(f.member, {}, { memoryWritable: true }),
    /read-only copy of your team lead's memory/,
  );
  assert.match(
    assistantBootstrap(f.member, {}, { memoryWritable: true }),
    /Memory is read-only right now/,
  );
});
