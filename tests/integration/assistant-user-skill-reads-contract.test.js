import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { compiledShell } from "../helpers/assistant-shell-compiled.js";
import { connectSkillCatalog } from "../../server/application/skill-catalog-wiring.js";

// Which skill files an agent of a restricted user reads on the pinned OpenClaw
// (AGENTPIER-262). All catalog skills share one live root (`skills.load.extraDirs`),
// but OpenClaw's read tool admits, beside the workspace (`tools.fs.workspaceOnly`),
// only the folder of each skill the agent's own snapshot resolves
// (core-coding-tools resolveSkillReadRoots): the catalog skills switched on for it,
// its bundled skills, and nothing else of the catalog by the spellings tried. Its own
// workspace skills read as workspace files. Switching a skill off withdraws its
// folder from the next turn.
const installed = process.env.AGENTPIER_SKILLS_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SKILLS_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};
const userAccess = {
  mode: "own",
  members: [{ userId: "user-fixture", level: "extended" }],
  released: [],
};
// A bundled skill without requirements, listed to every agent that switches it on.
const bundled = "skill-creator";
const pack = (name, text) => ({
  name,
  description: "Probe skill",
  files: [
    [
      "SKILL.md",
      Buffer.from(`---\nname: ${name}\ndescription: Probe skill\n---\n${text}\n`),
    ],
  ],
});
const meta = { importKind: "upload", scan: { verdict: "clean", rules: [] } };
const refused =
  /Path escapes sandbox root|not available to this agent|MEMORY_PATH_NOT_ALLOWED/;

// The `<location>` the system prompt lists for skill `name`, if any.
function location(input, name) {
  const text = (input.messages || [])
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  return text
    .match(new RegExp(`<name>${name}</name>[\\s\\S]*?<location>([^<]+)</location>`))?.[1]
    .trim();
}

test(
  "a user agent reads only the catalog skills switched on for it",
  options,
  async (t) => {
    // `[cmd:<label>]` makes the model call what `calls` holds for the label: a tool
    // call, or a function of the request for a call at a listed location.
    const calls = new Map();
    const h = await compiledShell(t, installed, {
      prefix: "user-skill-reads-",
      tool: (input) => {
        const text = JSON.stringify(input.messages);
        const label = [...calls.keys()].find((l) => text.includes(`[cmd:${l}]`));
        const call = label && calls.get(label);
        return typeof call === "function" ? call(input) : call;
      },
    });
    const catalog = connectSkillCatalog({
      assistantRuntime: h.runtime,
      assistants: h.assistants,
    });
    t.after(() => catalog.close());
    catalog.store.write(pack("shown-probe", "SHOWN-MARK-41"), meta);
    catalog.store.write(pack("hidden-probe", "HIDDEN-MARK-73"), meta);
    const hidden = path.join(catalog.store.liveRoot, "hidden-probe", "SKILL.md");
    const shownDir = path.join(catalog.store.liveRoot, "shown-probe");

    const agent = h.create("User agent");
    // Memory brings the `read` tool; OpenClaw lists skills only to agents that have it.
    h.store.updateAssistant(
      agent.id,
      {
        capabilities: { memory: true, reminders: false },
        skills: ["shown-probe", bundled],
      },
      h.store.getAssistant(agent.id).revision,
    );
    h.store.changeUserAgent(agent.id, { userAccess });
    const own = path.join(h.runtime.paths.workspaces, agent.id, "skills", "own-probe");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(
      path.join(own, "SKILL.md"),
      "---\nname: own-probe\ndescription: Own skill\n---\nOWN-MARK-58\n",
    );
    await h.runtime.start();
    await h.config.apply(agent.id);
    const runtimeId = h.store.getAssistant(agent.id).runtimeAgentId;
    assert.deepEqual((await h.running()).agents.entries[runtimeId].skills, [
      "shown-probe",
      bundled,
    ]);
    assert.equal((await h.running()).tools?.fs?.workspaceOnly, true);

    // The owner has no chat with a user's own agent: each turn runs on the Gateway.
    const read = async (label, call) => {
      calls.set(label, call);
      const outcome = await h.direct(runtimeId, label, "true");
      t.diagnostic(`${label}: ${JSON.stringify(outcome.result?.slice(0, 160))}`);
      return outcome.result || "";
    };
    const listed = (name) => (input) => {
      const at = location(input, name);
      return at && { name: "read", arguments: { path: at } };
    };

    // What is switched on, bundled or its own reads.
    assert.match(await read("shown", listed("shown-probe")), /SHOWN-MARK-41/);
    assert.match(await read("bundled", listed(bundled)), new RegExp(`name: ${bundled}`));
    const ownRead = await read("own", {
      name: "read",
      arguments: { path: "skills/own-probe/SKILL.md" },
    });
    assert.match(ownRead, /OWN-MARK-58/);

    // Nothing else of the catalog, by each spelling and tool tried here.
    const attempts = {
      absolute: { name: "read", arguments: { path: hidden } },
      folder: { name: "read", arguments: { path: path.dirname(hidden) } },
      sibling: {
        name: "read",
        arguments: { path: `${shownDir}/../hidden-probe/SKILL.md` },
      },
      relative: {
        name: "read",
        arguments: { path: "../../skill-catalog/skills/hidden-probe/SKILL.md" },
      },
      url: { name: "read", arguments: { path: `file://${hidden}` } },
      memory: { name: "memory_get", arguments: { path: hidden } },
      // A case variant names the same folder only on a case-insensitive file system.
      ...(process.platform === "darwin" && {
        folded: {
          name: "read",
          arguments: { path: hidden.replace("hidden-probe", "HIDDEN-PROBE") },
        },
      }),
      named: { name: "skills_read", arguments: { name: "hidden-probe" } },
    };
    for (const [label, call] of Object.entries(attempts)) {
      const result = await read(`hidden-${label}`, call);
      assert.match(result, refused, label);
      assert.doesNotMatch(result, /HIDDEN-MARK-73/, label);
    }

    // Switched off, the skill's folder leaves the next turn's read roots.
    await h.idle();
    h.store.updateAssistant(
      agent.id,
      { skills: [bundled] },
      h.store.getAssistant(agent.id).revision,
    );
    await h.config.apply(agent.id);
    const off = await read("off", {
      name: "read",
      arguments: { path: path.join(shownDir, "SKILL.md") },
    });
    assert.match(off, refused);
    assert.doesNotMatch(off, /SHOWN-MARK-41/);
  },
);
