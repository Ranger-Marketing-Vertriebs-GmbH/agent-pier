import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { hermesSkip } from "../helpers/hermes-native.js";
import { hermesFleetApp } from "../helpers/hermes-app.js";
import { homeRefusal } from "../../server/features/assistants/hermes-home-guard.js";

// Which catalog skills a Hermes agent of a restricted user reads on the pinned Hermes
// (AGENTPIER-262). Hermes offers each switched-on catalog skill from its own folder of
// the catalog's live copy (`skills.external_dirs`, hermes-config/skills.js), so
// skill_view finds only those and refuses a path out of the skill; its file tools
// stay in its work folder and chat folders (hermes-home-guard.js), which no catalog
// skill lies in. The in-repo fake model drives every tool call ("CALL:").
const options = { skip: hermesSkip, timeout: contractTimeout(900000) };
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

test(
  "Hermes contract: a user agent reads only the catalog skills switched on for it",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const app = await hermesFleetApp(t, model);
    const { assistants, fleet } = app;
    const store = assistants.skills.catalog;
    store.write(pack("shown-probe", "SHOWN-MARK-41"), meta);
    store.write(pack("hidden-probe", "HIDDEN-MARK-73"), meta);
    // Memory gives a Hermes agent without a shell its file tools (hermes-config/tools.js).
    const created = await app.createAgent({
      name: "Hermes user agent",
      shell: "off",
      capabilities: { memory: true, reminders: false },
    });
    assistants.store.updateAssistant(
      created.id,
      { skills: ["shown-probe"] },
      assistants.store.getAssistant(created.id).revision,
    );
    assistants.store.setUserAccess(
      created.id,
      {
        mode: "own",
        members: [{ userId: "user-a", level: "extended" }],
        released: [],
      },
      assistants.store.getAssistant(created.id).revision,
    );
    await assistants.config.apply(created.id);
    await app.ready(created);
    // A skill of the agent's own in its home, as skill_manage writes one.
    const home = fleet.sets.get(created.runtimeAgentId).supervisor.agentPaths();
    const own = path.join(home.hermesHome, "skills", "own-probe");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(
      path.join(own, "SKILL.md"),
      "---\nname: own-probe\ndescription: Own skill\n---\nOWN-MARK-58\n",
    );
    // The owner has no chat with a user's own agent: its turns go through its runtime.
    const { key } = await fleet.runtimeOf(created).sessions.create({
      agentId: created.runtimeAgentId,
      label: "skill reads",
      idempotencyKey: "skill-reads",
    });
    assistants.store.saveConversation({
      assistantId: created.id,
      runtimeSessionKey: key,
      userId: "user-a",
    });
    const call = async (tool, args) => {
      const runId = `turn-${randomUUID()}`;
      const { sessions } = fleet.runtimeOf(created);
      await sessions.send({
        key,
        turn: { message: `CALL: ${tool} ${JSON.stringify(args)}` },
        idempotencyKey: runId,
      });
      await eventually(
        async () => (await sessions.wait({ runId, waitMs: 1000 })).status !== "timeout",
        120000,
        `the turn calling ${tool}`,
      );
      const history = await sessions.history({ sessionKey: key, limit: 4 });
      const reply =
        history.messages.filter((m) => m.role === "assistant").at(-1)?.text || "";
      t.diagnostic(`${tool}: ${JSON.stringify(reply.slice(0, 160))}`);
      return reply;
    };

    // The switched-on, the essential bundled and its own skill read through
    // skill_view; the skill list names no other catalog skill.
    assert.match(await call("skill_view", { name: "shown-probe" }), /SHOWN-MARK-41/);
    assert.match(
      await call("skill_view", { name: "hermes-agent" }),
      /"success": true, "name": "hermes-agent"/,
    );
    assert.match(await call("skill_view", { name: "own-probe" }), /OWN-MARK-58/);
    const listed = await call("skills_list", {});
    assert.match(listed, /shown-probe/);
    assert.doesNotMatch(listed, /hidden-probe/);

    // Nothing else of the catalog: not by name, not out of the switched-on skill, not
    // with a file tool.
    const hidden = path.join(store.liveRoot, "hidden-probe", "SKILL.md");
    const attempts = [
      ["skill_view", { name: "hidden-probe" }, /not found/],
      [
        "skill_view",
        { name: "shown-probe", file_path: "../hidden-probe/SKILL.md" },
        /traversal/i,
      ],
      ["read_file", { path: hidden }, homeRefusal],
      ["search_files", { pattern: "HIDDEN-MARK-73", path: store.liveRoot }, homeRefusal],
    ];
    for (const [tool, args, refusal] of attempts) {
      const reply = await call(tool, args);
      if (typeof refusal === "string") assert.ok(reply.includes(refusal), reply);
      else assert.match(reply, refusal);
      assert.doesNotMatch(reply, /HIDDEN-MARK-73/, tool);
    }

    // Switched off, the skill is gone from the next turn.
    assistants.store.updateAssistant(
      created.id,
      { skills: [] },
      assistants.store.getAssistant(created.id).revision,
    );
    await assistants.config.apply(created.id);
    await app.ready(created);
    const off = await call("skill_view", { name: "shown-probe" });
    assert.match(off, /not found/);
    assert.doesNotMatch(off, /SHOWN-MARK-41/);
  },
);
