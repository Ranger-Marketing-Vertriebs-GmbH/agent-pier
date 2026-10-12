import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { listTree } from "../helpers/assistant-shell-gateway.js";
import {
  compiledShell,
  confirmFull,
  ownerProgram,
} from "../helpers/assistant-shell-compiled.js";

// Unlike assistant-shell-contract.test.js, which patches tools.exec by hand to
// qualify OpenClaw (docs/assistant-shell-qualification.md), this contract drives
// AgentPier's own path in team mode: the start compile, level changes through
// AssistantService, approval intake and the owner's decisions through
// AssistantWorkflows, and the allowlist. Every command touches only the test's own
// temporary directory; the owner account is simulated there.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: 400000,
};
const entryOf = async (h, agent) =>
  (await h.running()).agents.entries[h.store.getAssistant(agent.id).runtimeAgentId];

test(
  "approval: AgentPier's decisions and allowlist on the compiled path",
  options,
  async (t) => {
    const h = await compiledShell(t, installed, { prefix: "shell-compiled-approval-" });
    const { at, assistants } = h;
    const agent = h.create("Home");
    await assert.rejects(h.level(agent, "approval"), { status: 409 });
    await h.level(agent, "approval", { confirmShell: true });
    await h.runtime.start();
    await h.config.apply(agent.id);
    const entry = await entryOf(h, agent);
    assert.deepEqual(entry.tools.exec, {
      mode: "ask",
      strictInlineEval: true,
      pathPrepend: [h.owner.bin],
    });
    assert.ok((await h.running()).tools.allow.includes("exec"));
    const generation = h.runtime.generation;
    const state = (action) => h.workflows.get(action.id);

    // allow-once runs the command once; the same command asks again, deny never runs.
    const once = await h.send(agent, "once", `touch ${at("once")}`);
    const asked = await h.action(once);
    assert.ok(asked.payload.allowedDecisions.includes("allow-always"));
    assert.equal(h.workflows.project(asked).allowAlwaysByAgentPier, false);
    await h.decide(asked, "allow-once");
    await h.settle(once);
    assert.equal(fs.existsSync(at("once")), true);
    assert.deepEqual(
      [state(asked).state, state(asked).result],
      ["completed", { decision: "allow-once" }],
    );
    fs.rmSync(at("once"));
    const again = await h.send(agent, "again", `touch ${at("once")}`);
    const denied = await h.action(again);
    await h.decide(denied, "deny");
    const deniedTurn = await h.settle(again);
    assert.match(deniedTurn.result, /Exec denied/);
    assert.equal(fs.existsSync(at("once")), false);
    assert.equal(state(denied).state, "declined");

    // allow-always offered by OpenClaw: the next run of the command does not ask.
    const always = await h.send(agent, "always", `touch ${at("always")}`);
    await h.decide(await h.action(always), "allow-always");
    await h.settle(always);
    fs.rmSync(at("always"));
    await h.silent(await h.send(agent, "always-again", `touch ${at("always")}`));
    assert.equal(fs.existsSync(at("always")), true);
    const openclaw = (await assistants.allowlist.list(agent.id)).entries;
    t.diagnostic(`allowlist=${JSON.stringify(openclaw)}`);
    assert.equal(openclaw.length, 1);
    assert.equal(openclaw[0].source, "openclaw");
    assert.equal(openclaw[0].command, `touch ${at("always")}`);
    // Deleting it in AgentPier asks again.
    await h.idle();
    await assistants.allowlist.remove(agent.id, openclaw[0].id);
    fs.rmSync(at("always"));
    const removed = await h.send(agent, "removed", `touch ${at("always")}`);
    await h.decide(await h.action(removed), "deny");
    await h.settle(removed);
    assert.equal(fs.existsSync(at("always")), false);

    // A user-owned program: OpenClaw withholds allow-always, AgentPier answers it with
    // allow-once and a program-path entry; other arguments then run unasked.
    const mark = ownerProgram(h, "mark", 'touch "$1"');
    const owned = await h.send(agent, "owned", `mark ${at("m1")}`);
    const fallback = await h.action(owned);
    assert.deepEqual(fallback.payload.allowedDecisions, ["allow-once", "deny"]);
    const projected = h.workflows.project(fallback);
    assert.equal(projected.allowAlwaysByAgentPier, true);
    assert.deepEqual(projected.allowAlwaysPlan, {
      kind: "paths",
      paths: [mark],
      writable: [mark],
    });
    await h.decide(fallback, "allow-always");
    await h.settle(owned);
    assert.equal(fs.existsSync(at("m1")), true);
    const written = state(fallback).result;
    assert.equal(written.decision, "allow-always");
    assert.equal(written.resolvedAs, "allow-once");
    assert.equal(written.allowlist.written, true);
    await h.silent(await h.send(agent, "owned-other", `mark ${at("m2")}`));
    assert.equal(fs.existsSync(at("m2")), true, "other arguments run unasked");
    const ours = (await assistants.allowlist.list(agent.id)).entries;
    assert.deepEqual(
      ours.map((e) => [e.source, e.kind, e.pattern, e.argPattern]),
      [["agentpier", "program", mark, undefined]],
    );
    const answered = h.audit.filter((e) => e.action === "assistant.answered");
    assert.equal(answered.at(-1).details.allowlist, "written");

    // An interpreter: allowed once, no entry; the next run asks again.
    const node = fs.realpathSync(path.join(installed, "node/bin/node"));
    fs.writeFileSync(
      at("mark.js"),
      "require('fs').writeFileSync(process.argv[2], '');\n",
    );
    const script = (name) => `${node} ${at("mark.js")} ${at(name)}`;
    const interpreted = await h.send(agent, "interpreter", script("n1"));
    const once2 = await h.action(interpreted);
    assert.deepEqual(h.workflows.project(once2).allowAlwaysPlan, {
      kind: "once",
      reason: "interpreter",
      program: node,
    });
    await h.decide(once2, "allow-always");
    await h.settle(interpreted);
    assert.equal(fs.existsSync(at("n1")), true);
    assert.equal(state(once2).result.allowlist.skipped, "interpreter");
    const reasked = await h.send(agent, "interpreter-again", script("n2"));
    await h.decide(await h.action(reasked), "deny");
    await h.settle(reasked);
    assert.equal(fs.existsSync(at("n2")), false);
    assert.equal((await assistants.allowlist.list(agent.id)).entries.length, 1);
    assert.equal(h.runtime.generation, generation, "no restart");
  },
);

test("full, off and the owner's environment on the compiled path", options, async (t) => {
  const h = await compiledShell(t, installed, { prefix: "shell-compiled-full-" });
  const { at } = h;
  const agent = h.create("Home");
  await assert.rejects(h.level(agent, "full", { confirmShell: true }), { status: 409 });
  await h.level(agent, "full", confirmFull);
  await h.runtime.start();
  await h.config.apply(agent.id);
  assert.deepEqual((await entryOf(h, agent)).tools.exec, {
    mode: "full",
    pathPrepend: [h.owner.bin],
  });
  const generation = h.runtime.generation;

  // Full runs unasked, as the owner: owner HOME and login PATH, no Gateway token.
  const out = at("probe.txt");
  const probe =
    `{ printf 'HOME=%s\\n' "$HOME"; printf 'PATH=%s\\n' "$PATH"; ` +
    `printf 'GH=%s\\n' "$(command -v gh)"; gh 2>/dev/null; ` +
    `env | cut -d= -f1 | grep '^OPENCLAW' | sort; } > ${out} 2>&1`;
  await h.silent(await h.send(agent, "probe", probe));
  const lines = fs.readFileSync(out, "utf8").trim().split("\n");
  t.diagnostic(`probe=${JSON.stringify(lines.filter((l) => !l.startsWith("PATH=")))}`);
  const value = (key) =>
    lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);
  assert.equal(value("HOME"), h.owner.home);
  assert.ok(value("PATH").split(":").includes(h.owner.bin));
  assert.equal(value("GH"), path.join(h.owner.bin, "gh"));
  assert.ok(lines.includes("fake-gh   user: fixture"), "gh reads the owner's login");
  const names = lines.filter((l) => /^OPENCLAW[A-Z0-9_]*$/.test(l));
  assert.equal(names.includes("OPENCLAW_GATEWAY_TOKEN"), false);
  assert.equal(names.includes("OPENCLAW_HOME"), false);
  // The Gateway keeps its state private and writes nothing into the owner's HOME.
  const approvals = await h.runtime.client.call("exec.approvals.get", {});
  assert.ok(approvals.path.startsWith(h.runtime.paths.state + path.sep));
  assert.deepEqual(listTree(h.owner.home), h.owner.tree);
  const wrapper = path.join(h.runtime.paths.root, "exec-shell", "sh");
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o500);

  // full → off applies live: the next turn is offered no exec at all.
  await h.idle();
  const off = await h.level(agent, "off");
  assert.equal(off.pending, undefined);
  const none = await h.settle(await h.send(agent, "off", `touch ${at("off")}`));
  assert.equal(none.offered.includes("exec"), false);
  assert.equal(fs.existsSync(at("off")), false);
  assert.equal((await h.running()).tools.allow.includes("exec"), false);
  assert.equal((await entryOf(h, agent)).tools.exec, undefined);

  // A request still awaiting the owner when shell goes off is denied and never runs.
  await h.idle();
  await h.level(agent, "approval", { confirmShell: true });
  const pending = await h.send(agent, "pending", `touch ${at("pending")}`);
  const action = await h.action(pending);
  await h.level(agent, "off");
  const ended = h.workflows.get(action.id);
  assert.deepEqual([ended.state, ended.diagnostic], ["declined", "SHELL_OFF"]);
  await h.settle(pending);
  assert.equal(fs.existsSync(at("pending")), false);
  await assert.rejects(h.decide(ended, "allow-once"), { status: 409 });
  assert.equal(h.runtime.generation, generation, "no restart");
  assert.equal(h.runtime.status().availability, "ready");
});

test(
  "team mode: a permanent member's shell works, a temporary member never gets one",
  options,
  async (t) => {
    const h = await compiledShell(t, installed, { prefix: "shell-compiled-team-" });
    const { at, store } = h;
    const lead = h.create("Lead");
    const member = (id, lifetime) =>
      store.reserveMember({
        id,
        parent: lead.id,
        assignment: { name: id },
        snapshot: {
          model: { connectionId: "fixture", modelId: "fixture-model" },
          instructions: "",
        },
        teamId: "team",
        lifetime,
      });
    const keeper = member("keeper", "permanent");
    const helper = member("helper", "temporary");
    await h.level(keeper, "full", confirmFull);
    await assert.rejects(h.level(helper, "full", confirmFull), { status: 400 });
    // Even a level stored for a temporary member by other means never compiles.
    const raw = store.getAssistant(helper.id);
    store.db
      .prepare("UPDATE assistants SET body=? WHERE id=?")
      .run(JSON.stringify({ ...raw, shell: "full" }), helper.id);
    await h.runtime.start();
    for (const agent of [lead, keeper, helper]) await h.config.apply(agent.id);
    const running = await h.running();
    t.diagnostic(`plugins.allow=${JSON.stringify(running.plugins.allow)}`);
    assert.ok(running.plugins.allow.includes("agentpier-teams"), "team mode");
    assert.ok(running.tools.allow.includes("exec"));
    assert.equal((await entryOf(h, keeper)).tools.exec.mode, "full");
    for (const agent of [lead, helper]) {
      const entry = await entryOf(h, agent);
      assert.equal(entry.tools?.exec, undefined, agent.id);
      assert.equal((entry.tools?.allow || []).includes("exec"), false, agent.id);
    }

    const kept = await h.direct(keeper.runtimeAgentId, "keeper", `touch ${at("keeper")}`);
    assert.ok(kept.offered.includes("exec"));
    assert.equal(fs.existsSync(at("keeper")), true);
    for (const agent of [helper, lead]) {
      const turn = await h.direct(
        agent.runtimeAgentId,
        agent.id,
        `touch ${at(agent.id)}`,
      );
      assert.equal(turn.offered.includes("exec"), false, agent.id);
      assert.equal(fs.existsSync(at(agent.id)), false, agent.id);
    }
    await assert.rejects(h.assistants.allowlist.list(helper.id), { status: 400 });
  },
);

test("a restart with a pending approval ends its action", options, async (t) => {
  const h = await compiledShell(t, installed, { prefix: "shell-compiled-restart-" });
  const { at } = h;
  const agent = h.create("Home");
  await h.level(agent, "approval", { confirmShell: true });
  await h.runtime.start();
  await h.config.apply(agent.id);
  const turn = await h.send(agent, "pending", `touch ${at("pending")}`);
  const action = await h.action(turn);
  await h.runtime.restart();
  // AgentPier reconciles at the ready: the Gateway's history says cancelled.
  const ended = await h.action(turn, "cancelled");
  t.diagnostic(`ended=${JSON.stringify({ state: ended.state, result: ended.result })}`);
  assert.equal(ended.id, action.id);
  await assert.rejects(h.decide(ended, "allow-once"), { status: 409 });
  assert.equal(fs.existsSync(at("pending")), false);
  // The restarted Gateway compiled the level again: the next command asks.
  const next = await h.send(agent, "after", `touch ${at("after")}`);
  await h.decide(await h.action(next), "allow-once");
  await h.settle(next);
  assert.equal(fs.existsSync(at("after")), true);
});
