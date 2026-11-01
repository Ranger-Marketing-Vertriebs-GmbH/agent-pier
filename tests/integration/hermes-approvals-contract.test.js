import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import {
  collectEvents,
  endsRun,
  hermesSandbox,
  hermesSkip,
  startHermes,
  strayAfterStop,
} from "../helpers/hermes-native.js";

// Hermes's own approval model against the pinned Hermes as AgentPier runs it (the
// supervised gateway and the RPC bridge, hermes-native.js), with the agent's home
// compiled for shell mode approval: a dangerous command asks AgentPier (the
// gateway's `approval.request` event), the exec approval the adapter makes of it is
// answered through the approvals sub-port, deny blocks the command and allow once
// runs it; a harmless command runs without asking.
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const agentId = "hermes-agent";

test(
  "Hermes contract: a dangerous command waits for the owner; deny blocks, once runs",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const dirs = hermesSandbox(t);
    const { sessions, events, approvals, agent, stop } = await startHermes(t, dirs, {
      agentId,
      model,
    });
    const build = path.join(agent.workspace, "build");
    fs.mkdirSync(build);
    fs.writeFileSync(path.join(build, "x.txt"), "x");
    const run = collectEvents(events);
    const { key } = await sessions.create({ agentId, label: "Approvals" });

    // A harmless command runs without a question.
    await sessions.send({ key, turn: { message: "RUN: ls -la" }, idempotencyKey: "ls" });
    assert.equal((await run.until(endsRun("ls"))).kind, "finished");
    assert.equal(run.seen.filter((e) => e.kind === "approval.requested").length, 0);

    const answer = async (runId, decision) => {
      await sessions.send({
        key,
        turn: { message: "RUN: rm -rf build" },
        idempotencyKey: runId,
      });
      const asked = await run.until(
        (e) => e.kind === "approval.requested" && e.runId === runId,
      );
      assert.equal(asked.event, "exec.approval.requested");
      assert.equal(asked.sessionKey, key);
      const { id, request } = asked.payload;
      assert.equal(request.command, "rm -rf build");
      assert.equal(request.agentId, agentId);
      assert.deepEqual(request.allowedDecisions, ["allow-once", "allow-session", "deny"]);
      assert.equal(request.warningText, "recursive delete");
      assert.deepEqual(
        (await approvals.list()).map((item) => item.id),
        [id],
      );
      await approvals.resolve({ id, decision });
      const resolved = await run.until(
        (e) => e.kind === "approval.resolved" && e.payload.id === id,
      );
      assert.equal(resolved.payload.decision, decision);
      assert.equal((await run.until(endsRun(runId))).kind, "finished");
      const tool = run.seen.find(
        (e) =>
          e.runId === runId &&
          e.event === "tool.complete" &&
          e.payload.name === "terminal",
      );
      return { id, tool };
    };

    const denied = await answer("deny", "deny");
    assert.equal(fs.existsSync(build), true);
    assert.match(JSON.stringify(denied.tool.payload.result), /BLOCKED/);
    const allowed = await answer("once", "allow-once");
    assert.equal(fs.existsSync(build), false);
    assert.deepEqual(
      (await approvals.history()).items.map((i) => [i.id, i.status, i.decision]),
      [
        [denied.id, "denied", "deny"],
        [allowed.id, "allowed", "allow-once"],
      ],
    );
    assert.deepEqual(await approvals.list(), []);
    run.unsubscribe();
    await stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);
