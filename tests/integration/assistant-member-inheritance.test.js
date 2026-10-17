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
import {
  mirrorLeadMemory,
  mirrorName,
} from "../../server/features/assistants/member-memory.js";
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
// Everything a member can get without the owner's shell and SSH setting.
const granted = { ...everything, skills: true };
const paths = { workspaces: "/data/workspaces", logs: "/data/logs" };
const webTools = {
  search: { provider: "duckduckgo", requiresPlugin: true },
  browser: { available: true, name: "Chrome", executablePath: "/bin/chrome" },
  searchPlugins: {
    duckduckgo: { id: "duckduckgo", directory: "/rt/duckduckgo" },
  },
};

function fixture(t, { memberShellSsh = false, grants = granted } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-member-inherit-"));
  const store = new AssistantStore({ dataDir });
  const ledger = new RequestLedger(store.db);
  const access = new AssistantAccess({ assistants: { store } });
  const teams = new TeamStore({ store, sshGranted: (id) => access.hasSshGrants(id) });
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
    members: [{ name: "Scout", role: "Research", assignment: "Look around", grants }],
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

test("a task member's compiled entry carries what its lead granted: web, skills, read-only memory", (t) => {
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

test("granted shell and SSH use the lead's level and grants with its setting", (t) => {
  const f = fixture(t, {
    memberShellSsh: true,
    grants: { ...granted, shell: "approval", ssh: true },
  });
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

test("the copy of the lead's memory lives apart from the member's own memory", async (t) => {
  const f = fixture(t);
  const root = path.join(f.dataDir, "workspaces");
  const lead = path.join(root, f.lead.id),
    own = path.join(root, f.member.id),
    mirror = path.join(own, "memory", "lead");
  fs.mkdirSync(path.join(lead, "memory", "projects"), { recursive: true });
  fs.mkdirSync(path.join(own, "memory"), { recursive: true });
  fs.writeFileSync(path.join(lead, "MEMORY.md"), "Lead facts");
  fs.writeFileSync(path.join(lead, "memory", "projects", "atlas.md"), "Atlas notes");
  fs.writeFileSync(path.join(lead, "memory", "secret.txt"), "not a note");
  // The member's own memory.
  fs.writeFileSync(path.join(own, "MEMORY.md"), "My facts");
  fs.writeFileSync(path.join(own, "memory", "2026-10-17.md"), "My day");
  await mirrorLeadMemory(root, f.member, true);
  assert.equal(fs.readFileSync(path.join(mirror, "MEMORY.md"), "utf8"), "Lead facts");
  assert.equal(
    fs.readFileSync(path.join(mirror, "note-projects~satlas.md"), "utf8"),
    "Atlas notes",
  );
  assert.deepEqual(fs.readdirSync(mirror).sort(), [
    "MEMORY.md",
    "note-projects~satlas.md",
  ]);
  assert.equal(fs.readFileSync(path.join(own, "MEMORY.md"), "utf8"), "My facts");
  // Whatever lands in the copy is replaced by the lead's again before the next turn.
  fs.writeFileSync(path.join(mirror, "MEMORY.md"), "Injected");
  fs.writeFileSync(path.join(mirror, "planted.md"), "Planted");
  await mirrorLeadMemory(root, f.member, true);
  assert.equal(fs.readFileSync(path.join(mirror, "MEMORY.md"), "utf8"), "Lead facts");
  assert.equal(fs.existsSync(path.join(mirror, "planted.md")), false);
  assert.equal(fs.readFileSync(path.join(lead, "MEMORY.md"), "utf8"), "Lead facts");
  // Without the lead's memory grant (and on promotion) the copy goes, its own stays.
  await mirrorLeadMemory(root, f.member, false);
  assert.deepEqual(fs.readdirSync(mirror), []);
  assert.equal(fs.readFileSync(path.join(own, "MEMORY.md"), "utf8"), "My facts");
  assert.equal(
    fs.readFileSync(path.join(own, "memory", "2026-10-17.md"), "utf8"),
    "My day",
  );
  const guidance = assistantBootstrap(f.member, {}, { memoryWritable: true });
  assert.match(guidance, /Your memory is your own/);
  assert.match(
    guidance,
    /`memory\/lead\/` is a read-only copy of your team lead's memory/,
  );
  assert.doesNotMatch(guidance, /Memory is read-only right now/);
});

test("copies from the earlier layout are removed once", async (t) => {
  const f = fixture(t);
  const root = path.join(f.dataDir, "workspaces");
  const lead = path.join(root, f.lead.id),
    own = path.join(root, f.member.id);
  fs.mkdirSync(lead, { recursive: true });
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(lead, "MEMORY.md"), "Lead facts");
  fs.writeFileSync(path.join(lead, "USER.md"), "Owner prefs");
  // The old mirror wrote the lead's files into the member's own places.
  fs.writeFileSync(path.join(own, "MEMORY.md"), "Lead facts");
  fs.writeFileSync(path.join(own, "USER.md"), "Changed since");
  await mirrorLeadMemory(root, f.member, true);
  assert.equal(fs.existsSync(path.join(own, "MEMORY.md")), false);
  // Not identical: it may be the member's, so it stays.
  assert.equal(fs.readFileSync(path.join(own, "USER.md"), "utf8"), "Changed since");
});

test("a planted link in the member's copy is replaced, never written through", async (t) => {
  const f = fixture(t);
  const root = path.join(f.dataDir, "workspaces");
  const lead = path.join(root, f.lead.id),
    own = path.join(root, f.member.id),
    mirror = path.join(own, "memory", "lead");
  fs.mkdirSync(lead, { recursive: true });
  fs.mkdirSync(mirror, { recursive: true });
  fs.writeFileSync(path.join(lead, "MEMORY.md"), "Lead facts");
  const outside = path.join(f.dataDir, "outside.md");
  fs.writeFileSync(outside, "Untouched");
  fs.symlinkSync(outside, path.join(mirror, "MEMORY.md"));
  await mirrorLeadMemory(root, f.member, true);
  assert.equal(fs.readFileSync(outside, "utf8"), "Untouched");
  const copy = path.join(mirror, "MEMORY.md");
  assert.equal(fs.lstatSync(copy).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(copy, "utf8"), "Lead facts");
  // A linked mirror folder is never written through either.
  fs.rmSync(mirror, { recursive: true });
  const elsewhere = path.join(f.dataDir, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, mirror);
  await mirrorLeadMemory(root, f.member, true);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.deepEqual(
    fs.readdirSync(path.join(own, "memory")).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("mirror names never collide, and a planted folder in the copy is left alone", async (t) => {
  assert.notEqual(mirrorName("memory/a--b.md"), mirrorName("memory/a/b.md"));
  assert.notEqual(mirrorName("memory/a~sb.md"), mirrorName("memory/a/b.md"));
  const f = fixture(t);
  const root = path.join(f.dataDir, "workspaces");
  const lead = path.join(root, f.lead.id),
    mirror = path.join(root, f.member.id, "memory", "lead");
  fs.mkdirSync(path.join(lead, "memory", "a"), { recursive: true });
  fs.mkdirSync(path.join(mirror, "planted", "deep"), { recursive: true });
  fs.writeFileSync(path.join(mirror, "planted", "deep", "keep.md"), "x");
  fs.writeFileSync(path.join(lead, "memory", "a--b.md"), "flat");
  fs.writeFileSync(path.join(lead, "memory", "a", "b.md"), "nested");
  await mirrorLeadMemory(root, f.member, true);
  const names = fs.readdirSync(mirror).sort();
  assert.equal(names.filter((n) => n.startsWith("note-")).length, 2);
  // Only files are removed; a folder there is not walked or deleted.
  await mirrorLeadMemory(root, f.member, false);
  assert.deepEqual(fs.readdirSync(mirror), ["planted"]);
  assert.ok(fs.existsSync(path.join(mirror, "planted", "deep", "keep.md")));
});
