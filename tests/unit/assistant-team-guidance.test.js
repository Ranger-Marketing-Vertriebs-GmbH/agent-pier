import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assistantBootstrap } from "../../server/features/assistants/assistant-bootstrap.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { rosterLimit } from "../../server/features/assistants/team-guidance.js";
import { autonomousCaps } from "../../server/features/assistants/team-policy.js";
import { leadStoreFixture } from "../helpers/lead-request-fixture.js";

const lead = { id: "a", name: "Lead", instructions: "Help the owner." };
const members = [
  { name: "Scout", role: "Market research", lifetime: "permanent" },
  { name: "Writer", role: "Drafts texts", lifetime: "task" },
];
const prompt = (usage, list = members, assistant = lead) =>
  assistantBootstrap(assistant, {}, { team: { usage, members: list } });
const section = (text) => text.slice(text.indexOf("## Your team"));

test("every level names the members compactly, with their lifetime", () => {
  for (const usage of ["onRequest", "suggest", "autonomous"]) {
    const text = section(prompt(usage));
    assert.match(text, /^## Your team\n/);
    assert.match(
      text,
      /- "Scout": "Market research" \(permanent, takes tasks and questions\)\n/,
    );
    assert.match(text, /- "Writer": "Drafts texts" \(temporary, answers questions\)\n/);
    assert.match(text, /agentpier_team_ask/);
  }
  // Long lists stay compact: the rest is one line pointing to the members tool.
  const many = Array.from({ length: rosterLimit + 3 }, (_, n) => ({
    name: `M${n}`,
    role: "r".repeat(500),
    lifetime: "task",
  }));
  const text = section(prompt("suggest", many));
  assert.equal((text.match(/^- "M\d+"/gm) || []).length, rosterLimit);
  assert.match(text, /… and 3 more \(agentpier_team_members\)/);
  assert.ok(!text.includes("r".repeat(161)), "roles are cut");
});

test("the level decides when the lead involves its members", () => {
  const onRequest = section(prompt("onRequest"));
  assert.match(onRequest, /only when the owner asks you to/);
  assert.doesNotMatch(onRequest, /on your own|offer it to the owner/);

  const suggest = section(prompt("suggest"));
  assert.match(suggest, /offer it to the owner in one sentence/);
  assert.match(suggest, /counts as the owner's request: delegate with ownerRequested/);
  assert.match(suggest, /Never involve members for trivial requests/);
  assert.match(suggest, /Summarize members' answers/);
  assert.doesNotMatch(suggest, /on your own/);

  const autonomous = section(prompt("autonomous"));
  assert.match(autonomous, /delegate suitable tasks on your own/);
  assert.match(autonomous, /self-initiated/);
  assert.match(autonomous, /new team you propose on your own still waits/);
  assert.match(
    autonomous,
    new RegExp(
      `at most ${autonomousCaps.perTurn} questions or tasks on your own per turn and ${autonomousCaps.perHour} per hour`,
    ),
  );
  // Without members only the way to a team is described.
  const empty = section(prompt("autonomous", []));
  assert.match(empty, /no team members right now/);
  assert.match(empty, /agentpier_team_propose/);
  assert.doesNotMatch(section(prompt("onRequest", [])), /propose/);
});

test("only a lead with a roster gets the section", () => {
  assert.doesNotMatch(assistantBootstrap(lead, {}), /## Your team/);
  assert.doesNotMatch(prompt("unknown"), /## Your team/);
  assert.doesNotMatch(
    prompt("suggest", members, { ...lead, teamMemberId: "m" }),
    /Your team/,
  );
  assert.doesNotMatch(
    prompt("suggest", members, { ...lead, archivedAt: "x" }),
    /Your team/,
  );
  // The owner's instructions stay first.
  assert.ok(prompt("suggest").startsWith("Help the owner.\n\n## AgentPier"));
});

test("existing team policies read as suggest and keep it when saved", (t) => {
  const f = leadStoreFixture(t);
  const { assistant } = f.lead();
  assert.equal(f.teams.policy(assistant.id).usage, "suggest", "new agents");
  // A policy saved before the level existed.
  f.teams.insert({
    id: `policy:${assistant.id}`,
    kind: "policy",
    parentAssistantId: assistant.id,
    revision: 2,
    autonomous: true,
    maxMembers: 3,
    runTimeoutMinutes: 10,
  });
  assert.equal(f.teams.policy(assistant.id).usage, "suggest");
  const saved = f.teams.savePolicy(assistant.id, { maxMembers: 4 }, 2);
  assert.equal(saved.usage, "suggest");
  assert.equal(f.teams.find(`policy:${assistant.id}`).usage, "suggest");
  const changed = f.teams.savePolicy(
    assistant.id,
    { usage: "autonomous" },
    saved.revision,
  );
  assert.equal(changed.usage, "autonomous");
  assert.throws(
    () => f.teams.savePolicy(assistant.id, { usage: "always" }, changed.revision),
    { status: 400 },
  );
});

// A Gateway that keeps AGENTS.md and counts full applies (agents.update).
function gateway(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-team-guidance-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const assistant = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const files = {},
    calls = [];
  const client = {
    async call(method, params) {
      calls.push(method);
      if (method === "agents.list") return { agents: [{ id: assistant.runtimeAgentId }] };
      if (method === "agents.update") return {};
      if (method === "config.get")
        return {
          hash: "1",
          config: {
            agents: { entries: { [assistant.runtimeAgentId]: { model: "new/model" } } },
          },
        };
      if (method === "agents.files.get")
        return {
          file:
            files[params.name] === undefined
              ? { missing: true }
              : { content: files[params.name] },
        };
      if (method === "agents.files.set") {
        files[params.name] = params.content;
        return {};
      }
      assert.fail(method);
    },
  };
  const config = new AssistantConfig({
    client,
    store,
    workspaces: dataDir,
    models: { resolve: () => ({ modelRef: "new/model", display: {}, release() {} }) },
  });
  return { assistant, config, files, calls };
}

test("a changed roster rewrites AGENTS.md without a full apply", async (t) => {
  const g = gateway(t);
  let roster = { usage: "suggest", members: [members[0]] };
  g.config.teamRoster = () => roster;
  await g.config.apply(g.assistant.id);
  assert.match(g.files["AGENTS.md"], /"Scout": "Market research" \(permanent, takes/);
  assert.doesNotMatch(g.files["AGENTS.md"], /Writer/);
  const updates = () => g.calls.filter((m) => m === "agents.update").length;
  assert.equal(updates(), 1);
  // A new member and another level: the next turn's apply only writes the file.
  roster = { usage: "autonomous", members };
  await g.config.apply(g.assistant.id);
  assert.equal(updates(), 1, "no second full apply");
  assert.match(g.files["AGENTS.md"], /"Writer": "Drafts texts"/);
  assert.match(g.files["AGENTS.md"], /on your own/);
  // A roster that cannot be read leaves the section out instead of failing the turn.
  g.config.teamRoster = () => {
    throw Error("store closed");
  };
  await g.config.apply(g.assistant.id);
  assert.doesNotMatch(g.files["AGENTS.md"], /## Your team/);
  assert.equal(updates(), 1);
});
