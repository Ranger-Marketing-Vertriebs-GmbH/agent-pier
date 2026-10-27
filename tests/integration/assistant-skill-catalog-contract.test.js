import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compiledShell } from "../helpers/assistant-shell-compiled.js";

// The skill catalog's runtime mechanism against the pinned OpenClaw: AgentPier's own
// catalog root is the only `skills.load.extraDirs` entry, and each agent's allow list
// decides whether a skill there is visible. An agent that names the skill sees it in
// its prompt and reads its file through OpenClaw's skill read roots although
// `tools.fs.workspaceOnly` is on; an agent that does not name it never sees it.
const installed = process.env.AGENTPIER_SKILLS_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SKILLS_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};
const marker = "CATALOG-PROBE-7f3a";

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

// `[cmd:read]` reads the probe skill's file at the location the prompt lists.
function readTool(input) {
  if (!JSON.stringify(input.messages).includes("[cmd:read]")) return null;
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
    const folder = path.join(h.runtime.paths.catalogSkills, "catalog-probe");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "SKILL.md"),
      `---\nname: catalog-probe\ndescription: Probe skill\n---\n${marker}\n`,
    );
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
    // AgentPier's live apply keeps only names the Gateway reports as bundled, and
    // re-applies every agent once the Gateway is ready. Until the catalog is wired
    // in, the probe passes that check here, so the runtime alone decides visibility.
    const verify = h.config.verifySkills.bind(h.config);
    h.config.verifySkills = async (assistant, names) => {
      const own = names.filter((name) => name === "catalog-probe");
      const checked = await verify(
        assistant,
        names.filter((name) => !own.includes(name)),
      );
      return { ...checked, skills: [...checked.skills, ...own].sort() };
    };
    await h.runtime.start();
    await h.config.apply(a.id);
    await h.config.apply(b.id);
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
    // Direct Gateway turns: AgentPier's admission re-applies the agent, which drops
    // non-bundled names until the catalog is wired in.
    const fromA = h.model.requests.length;
    const turnA = await h.direct(a.runtimeAgentId, "read", "true");
    t.diagnostic(`A status=${turnA.status} offered=${turnA.offered.join(",")}`);
    t.diagnostic(`A result=${turnA.result}`);
    const promptA = JSON.stringify(h.model.requests.slice(fromA));
    assert.ok(promptA.includes("catalog-probe"));
    assert.ok(turnA.result?.includes(marker), "the read reached the catalog skill");
    const fromB = h.model.requests.length;
    const turnB = await h.direct(b.runtimeAgentId, "none", "true");
    t.diagnostic(`B status=${turnB.status} offered=${turnB.offered.join(",")}`);
    assert.ok(turnB.offered.includes("read"));
    const promptB = JSON.stringify(h.model.requests.slice(fromB));
    assert.ok(!promptB.includes("catalog-probe"));

    // The running configuration carries the locked load section.
    const running = await h.running();
    assert.deepEqual(running.skills.load.extraDirs, [h.runtime.paths.catalogSkills]);
    // The read above ran under workspaceOnly: OpenClaw's skill read roots admit it.
    assert.equal(running.tools?.fs?.workspaceOnly, true);
  },
);
