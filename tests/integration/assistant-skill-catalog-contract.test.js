import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compiledShell } from "../helpers/assistant-shell-compiled.js";
import { connectSkillCatalog } from "../../server/application/skill-catalog-wiring.js";

// The skill catalog's runtime mechanism against the pinned OpenClaw: AgentPier's own
// catalog root is the only `skills.load.extraDirs` entry, and each agent's allow list
// decides whether a skill there is visible. An agent that names the skill sees it in
// its prompt and reads its file through OpenClaw's skill read roots although
// `tools.fs.workspaceOnly` is on; an agent that does not name it never sees it.
// Everything runs through AgentPier's own path: the catalog store and its wiring, the
// owner's switch through AssistantService, and turns admitted by AgentPier, whose live
// apply checks the catalog copies before each turn.
const installed = process.env.AGENTPIER_SKILLS_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SKILLS_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};
const marker = "CATALOG-PROBE-7f3a";
const updated = "CATALOG-PROBE-9c1d";
const probePack = (text) => ({
  name: "catalog-probe",
  description: "Probe skill",
  files: [
    [
      "SKILL.md",
      Buffer.from(`---\nname: catalog-probe\ndescription: Probe skill\n---\n${text}\n`),
    ],
  ],
});
const meta = { importKind: "upload", scan: { verdict: "clean", rules: [] } };

// The `<location>` the system prompt lists for the probe skill, if any.
function probeLocation(input) {
  const text = (input.messages || [])
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  const block = text.match(
    /<name>catalog-probe<\/name>[\s\S]*?<location>([^<]+)<\/location>/,
  );
  return block?.[1].trim();
}

// `[cmd:read…]` reads the probe skill's file at the location the prompt lists.
function readTool(input) {
  if (!JSON.stringify(input.messages).includes("[cmd:read")) return null;
  const location = probeLocation(input);
  return location && { name: "read", arguments: { path: location } };
}

test(
  "a catalog skill is visible and readable only for agents whose list names it",
  options,
  async (t) => {
    const h = await compiledShell(t, installed, {
      prefix: "skill-catalog-",
      tool: readTool,
    });
    const catalog = connectSkillCatalog({
      assistantRuntime: h.runtime,
      assistants: h.assistants,
    });
    t.after(() => catalog.close());
    const store = catalog.store;
    store.write(probePack(marker), meta);
    const live = path.join(store.liveRoot, "catalog-probe", "SKILL.md");
    const a = h.create("Has");
    const b = h.create("Lacks");
    // Memory brings the `read` tool; OpenClaw lists skills only to agents that have it.
    const memory = { capabilities: { memory: true, reminders: false } };
    h.store.updateAssistant(
      a.id,
      { ...memory, skills: ["catalog-probe"] },
      h.store.getAssistant(a.id).revision,
    );
    h.store.updateAssistant(b.id, memory, h.store.getAssistant(b.id).revision);
    await h.runtime.start();
    await h.config.apply(a.id);
    await h.config.apply(b.id);
    const generation = h.runtime.generation;
    const entries = (await h.running()).agents.entries;
    assert.deepEqual(entries[a.runtimeAgentId].skills, ["catalog-probe"]);
    assert.equal(entries[b.runtimeAgentId].skills, undefined);

    const probe = async (agent) =>
      (
        await h.runtime.client.call("skills.status", { agentId: agent.runtimeAgentId })
      ).skills.find((s) => s.name === "catalog-probe");
    const onA = await probe(a);
    t.diagnostic(`source=${onA.source} filePath=${onA.filePath}`);
    assert.ok(onA.filePath.startsWith(h.runtime.paths.catalogSkills));
    assert.equal(onA.blockedByAgentFilter, false);
    const onB = await probe(b);
    assert.equal(onB.blockedByAgentFilter, true);

    // A turn on A lists the skill and reads its file; a turn on B never lists it.
    // Both are admitted by AgentPier, whose live apply runs before each turn.
    const turn = async (agent, label) => {
      const from = h.model.requests.length;
      const outcome = await h.settle(await h.send(agent, label, "true"));
      t.diagnostic(`${label} status=${outcome.status} offered=${outcome.offered}`);
      t.diagnostic(`${label} result=${outcome.result}`);
      return { ...outcome, prompt: JSON.stringify(h.model.requests.slice(from)) };
    };
    const turnA = await turn(a, "read-a");
    assert.ok(turnA.prompt.includes("catalog-probe"));
    assert.ok(turnA.result?.includes(marker), "the read reached the catalog skill");
    const turnB = await turn(b, "none-b");
    assert.ok(turnB.offered.includes("read"));
    assert.ok(!turnB.prompt.includes("catalog-probe"));

    // The running configuration carries the locked load section.
    const running = await h.running();
    assert.deepEqual(running.skills.load.extraDirs, [h.runtime.paths.catalogSkills]);
    // The read above ran under workspaceOnly: OpenClaw's skill read roots admit it.
    assert.equal(running.tools?.fs?.workspaceOnly, true);

    // The owner switches the skill on for B: applied live, B's next turn lists it.
    // AgentPier refuses a settings change while the agent's turn is still recorded.
    await h.idle();
    await h.assistants.update(
      b.id,
      { skills: ["catalog-probe"] },
      h.store.getAssistant(b.id).revision,
    );
    assert.deepEqual((await h.running()).agents.entries[b.runtimeAgentId].skills, [
      "catalog-probe",
    ]);
    const turnB2 = await turn(b, "read-b");
    assert.ok(turnB2.prompt.includes("catalog-probe"));
    assert.ok(turnB2.result?.includes(marker));

    // An update reaches A's next turn without a Gateway restart.
    store.write(probePack(updated), meta);
    const turnA2 = await turn(a, "read-a2");
    assert.ok(turnA2.result?.includes(updated), "the update reached the agent");
    assert.equal(h.runtime.generation, generation, "no Gateway restart");

    // A tampered live copy is restored before A's next turn.
    fs.chmodSync(live, 0o600);
    fs.writeFileSync(live, "---\nname: catalog-probe\ndescription: x\n---\nPLANTED\n");
    const turnA3 = await turn(a, "read-a3");
    assert.ok(turnA3.result?.includes(updated), "the restored copy was read");
    assert.ok(!turnA3.result?.includes("PLANTED"));
    assert.equal(h.runtime.generation, generation);
  },
);
