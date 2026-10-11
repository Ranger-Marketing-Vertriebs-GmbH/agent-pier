import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { publicTeam } from "../../server/features/assistants/team-service.js";
import { describeServers } from "../../server/features/assistants/team-mcp.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";

const model = { connectionId: "c", modelId: "m" };

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-team-mcp-"));
  const store = new AssistantStore({ dataDir });
  const servers = new McpServerStore({
    dataDir,
    pathEnv: "/fake/bin",
    exists: (file) => file === "/abs/files",
  });
  const teams = new TeamStore({ store, servers: () => servers });
  const ledger = new RequestLedger(store.db);
  t.after(() => {
    servers.close();
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const lead = store.createAssistant({ name: "Lead", instructions: "Lead", model });
  const other = store.createAssistant({ name: "Other", instructions: "Other", model });
  const github = servers.create({
    name: "github",
    transport: "http",
    url: "https://mcp.example.test/v1?key=secret",
    headers: { Authorization: "Bearer secret" },
  });
  const files = servers.create({
    name: "files",
    transport: "stdio",
    command: "/abs/files",
    env: { TOKEN: "secret" },
  });
  const mail = servers.create({
    name: "mail",
    transport: "http",
    url: "https://mail.example.test/",
  });
  servers.setBindings("agent", lead.id, [github.id, files.id]);
  servers.setBindings("agent", other.id, [mail.id]);
  const chat = store.saveConversation({ assistantId: lead.id, runtimeSessionKey: "s" });
  const request = ledger.accept(chat.id, { clientRequestId: "owner", text: "Team" });
  const attempt = ledger.recordAttempt(request.id);
  const input = (members) => ({
    operationId: "tool1",
    parentAttemptId: attempt.id,
    objective: "Plan",
    members,
    origin: { kind: "owner" },
  });
  const member = (name, mcpServers) => ({
    name,
    role: "Role",
    assignment: `Work ${name}`,
    ...(mcpServers ? { mcpServers } : {}),
  });
  return { store, servers, teams, lead, github, files, mail, input, member };
}

test("a member may only name servers bound to the lead; anything else stores nothing", (t) => {
  const f = fixture(t);
  for (const names of [["mail"], ["unknown"], ["github", "GitHub"], ["github", "mail"]])
    assert.throws(
      () => f.teams.propose(f.input([f.member("A", ["github"]), f.member("B", names)])),
      (error) =>
        error.status === 400 &&
        error.key === "teamMcpServerNotBound" &&
        toolError(error).code === "MCP_SERVER_NOT_BOUND",
    );
  for (const names of [
    "github",
    [1],
    [""],
    Array.from({ length: 17 }, (_, n) => `s${n}`),
  ])
    assert.throws(() => f.teams.propose(f.input([f.member("A", names)])), {
      status: 400,
    });
  assert.throws(
    () => f.teams.propose(f.input([{ ...f.member("A"), servers: ["github"] }])),
    { status: 400 },
  );
  assert.deepEqual(f.teams.list(), []);
  assert.deepEqual(f.store.listAssistants().length, 2);
});

test("the server list is part of the proposal and its fingerprint", (t) => {
  const f = fixture(t);
  const p = f.teams.propose(
    f.input([f.member("A", ["files", "github", "files"]), f.member("B")]),
  );
  assert.deepEqual(p.members, [
    { ...f.member("A"), mcpServerIds: [f.files.id, f.github.id] },
    f.member("B"),
  ]);
  // Replaying the same call returns the proposal; another list is another proposal.
  assert.equal(
    f.teams.propose(f.input([f.member("A", ["files", "github"]), f.member("B")])).id,
    p.id,
  );
  for (const changed of [
    [f.member("A", ["github"]), f.member("B")],
    [f.member("A"), f.member("B")],
    [f.member("A", ["files", "github"]), f.member("B", ["github"])],
  ])
    assert.throws(() => f.teams.propose(f.input(changed)), { status: 409 });
});

test("a proposal without servers keeps its earlier fingerprint and records", (t) => {
  const f = fixture(t);
  const members = [f.member("A"), f.member("B")];
  const p = f.teams.propose(f.input(members));
  const legacy = createHash("sha256")
    .update(JSON.stringify({ objective: "Plan", members }))
    .digest("hex");
  assert.equal(p.fingerprint, legacy);
  assert.deepEqual(p.members, members);
  assert.equal(
    f.teams.propose(f.input(members.map((m) => ({ ...m, mcpServers: [] })))).id,
    p.id,
  );
});

test("reserved members carry their approved servers", (t) => {
  const f = fixture(t);
  const p = f.teams.propose(f.input([f.member("A", ["github"]), f.member("B")]));
  f.teams.decide(p.id, { revision: p.revision, decision: "approve" }, { kind: "owner" });
  const team = f.teams.reserve(p.id);
  const [a, b] = team.memberIds.map((id) => f.teams.member(id));
  assert.deepEqual(a.mcpServerIds, [f.github.id]);
  assert.equal(b.mcpServerIds, undefined);
});

test("approval payloads show server names and the stdio marker only", (t) => {
  const f = fixture(t);
  const p = f.teams.propose(f.input([f.member("A", ["github", "files"]), f.member("B")]));
  const describe = (ids) => describeServers(f.servers, ids);
  const shown = publicTeam(p, describe);
  assert.deepEqual(shown.members, [
    {
      ...f.member("A"),
      mcpServers: [
        { name: "github", stdio: false },
        { name: "files", stdio: true },
      ],
    },
    f.member("B"),
  ]);
  const text = JSON.stringify(shown);
  for (const hidden of [f.github.id, f.files.id, "example.test", "/abs/files", "secret"])
    assert.ok(!text.includes(hidden), hidden);
  // A server deleted after the proposal is no longer listed.
  f.servers.remove(f.files.id);
  assert.deepEqual(publicTeam(p, describe).members[0].mcpServers, [
    { name: "github", stdio: false },
  ]);
  // Without a server store the payload shape is unchanged for plain members.
  assert.deepEqual(publicTeam(p).members[1], f.member("B"));
});
