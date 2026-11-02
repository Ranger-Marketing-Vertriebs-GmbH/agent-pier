import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { hermesFleetApp } from "../helpers/hermes-app.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";

// A Hermes agent of restricted users on the pinned Hermes
// (AGENTPIER_HERMES_CONTRACT_RUNTIME) holds none of the tools OpenClaw locks for such
// an agent (native-capabilities.js lockedTools): no shell, no subagents, no other
// chats, no team tools. They are not offered to the model, and a model that names
// one anyway gets a refusal while nothing runs. The in-repo fake model forces the
// calls ("FORCE:").
const options = { skip: hermesSkip, timeout: contractTimeout(900000) };
const userAccess = {
  mode: "own",
  members: [{ userId: "user-fixture", level: "extended" }],
  released: [],
};
const locked = ["terminal", "execute_code", "delegate_task", "session_search"];

test(
  "Hermes contract: a restricted user's agent cannot call a locked tool",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const app = await hermesFleetApp(t, model);
    const { assistants, fleet } = app;
    const created = await app.createAgent({
      name: "Hermes user agent",
      shell: "full",
      confirmShell: true,
      confirmFull: true,
    });
    const home = fleet.sets.get(created.runtimeAgentId).supervisor.agentPaths();
    const config = () =>
      readHermesConfig(
        fs.readFileSync(path.join(home.hermesHome, "config.yaml"), "utf8"),
      );
    assert.equal(config().agent.disabled_toolsets.includes("terminal"), false);

    // The agent becomes a restricted user's agent; its apply locks the tools.
    const current = assistants.store.getAssistant(created.id);
    assistants.store.setUserAccess(created.id, userAccess, current.revision);
    await assistants.config.apply(created.id);
    await eventually(
      () =>
        ["terminal", "code_execution", "delegation", "session_search"].every((name) =>
          config().agent.disabled_toolsets.includes(name),
        ),
      60000,
      "the locked toolsets in the agent's home",
    );
    await app.ready(created);

    // The owner has no chat with a user's agent: its turns go through its runtime.
    const { sessions } = fleet.runtimeOf(created);
    const { key } = await sessions.create({
      agentId: created.runtimeAgentId,
      label: "locked tools",
      idempotencyKey: "lock-chat",
    });
    const marker = path.join(home.workspace, "locked-tool-ran");
    const calls = {
      terminal: { command: `touch ${marker}` },
      execute_code: { code: `open(${JSON.stringify(marker)}, "w").write("x")` },
      delegate_task: { goal: `Create the file ${marker}` },
      session_search: { query: "anything" },
      agentpier_team_propose: { objective: "x", members: [] },
    };
    for (const [tool, args] of Object.entries(calls)) {
      const before = model.requests.length;
      const runId = `lock-${tool}`;
      await sessions.send({
        key,
        turn: { message: `FORCE: ${tool} ${JSON.stringify(args)}` },
        idempotencyKey: runId,
      });
      await eventually(
        async () => (await sessions.wait({ runId, waitMs: 1000 })).status !== "timeout",
        120000,
        `the turn calling ${tool}`,
      );
      const history = await sessions.history({ sessionKey: key, limit: 4 });
      const reply = history.messages.filter((m) => m.role === "assistant").at(-1)?.text;
      // Hermes answered the call with a refusal, not a result.
      assert.match(reply || "", /^TOOL_DONE: /, tool);
      assert.match(
        reply,
        /does not exist|unknown|not (?:available|found|enabled)|disabled/i,
        tool,
      );
      // The model was never offered any of the locked tools.
      const offered = model.requests
        .slice(before)
        .flatMap((r) => (r.body.tools || []).map((x) => x?.function?.name));
      for (const name of [...locked, "agentpier_team_propose"])
        assert.equal(offered.includes(name), false, `${name} offered`);
    }
    assert.equal(fs.existsSync(marker), false);

    await fleet.close();
    assert.deepEqual(await strayAfterStop({ root: path.dirname(home.hermesHome) }), []);
  },
);
