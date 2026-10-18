import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { writeExecAllowlistEntry } from "../../server/features/assistants/exec-decisions.js";
import {
  allowAlwaysPlan,
  isInterpreter,
} from "../../server/features/assistants/exec-allowlist-policy.js";
import {
  answer,
  decide,
  requestFor,
  shellGateway,
  silent,
} from "../helpers/assistant-shell-gateway.js";
import { shellQuote } from "../../server/lib/launch-serialization.js";

// docs/assistant-shell-qualification.md records what these tests establish. Every
// command touches only the test's own temporary directory.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: 300000,
};
const execTools = ["session_status", "exec", "process"];
// The runtime's node as a command word. A local install lives under "Application
// Support": unquoted, the shell splits it and OpenClaw denies the unresolvable program
// outright ("cannot safely bind"), so no approval request ever arrives.
const nodeWord = (node) => shellQuote(node);

test("allow-once, allow-always, deny and the allowlist", options, async (t) => {
  const gw = await shellGateway(t, installed, { prefix: "shell-approvals-" });
  const at = (name) => path.join(gw.dataDir, name);
  await gw.configure({ tools: { allow: execTools, exec: { mode: "ask" } } });
  const approver = await gw.approver();
  const policy = () => approver.call("exec.approvals.get", {});
  const run = (label, command) => gw.send(label, command);

  // allow-once runs the command once and records nothing.
  const onceRun = await run("once", `touch ${at("once")}`);
  const once = await decide(gw, approver, onceRun, "allow-once");
  t.diagnostic(`request=${JSON.stringify(once.request)}`);
  // AgentPier attributes a request through these: the session key it created the
  // conversation with, and the idempotency key it sent the turn with.
  assert.equal(once.request.request.sessionKey, onceRun.session.key);
  assert.equal(once.request.request.runId, "once");
  assert.deepEqual(once.request.request.allowedDecisions, [
    "allow-once",
    "allow-always",
    "deny",
  ]);
  const touch = once.request.request.resolvedPath;
  assert.equal(fs.existsSync(at("once")), true);
  const empty = await policy();
  t.diagnostic(`exec.approvals.get=${JSON.stringify(empty)}`);
  assert.equal(
    empty.path,
    `${gw.runtime.paths.state}/state/openclaw.sqlite#exec_approvals_config`,
  );
  assert.deepEqual(empty.file.agents, {});
  assert.deepEqual(empty.resolvedDefaults, {
    security: "full",
    ask: "off",
    askFallback: "deny",
    autoAllowSkills: false,
  });
  fs.rmSync(at("once"));
  // The same command asks again; deny never runs it.
  const denied = await decide(
    gw,
    approver,
    await run("again", `touch ${at("once")}`),
    "deny",
  );
  assert.ok(denied.request, "allow-once is not remembered");
  assert.match(denied.result, /Exec denied \(gateway id=.*, user-denied\)/);
  assert.equal(fs.existsSync(at("once")), false);
  // A deny event alone does not say who denied; approval.history gives the status.
  const resolution = approver.events.find(
    (e) => e.event === "exec.approval.resolved" && e.payload.id === denied.request.id,
  )?.payload;
  t.diagnostic(`exec.approval.resolved=${JSON.stringify(resolution)}`);
  assert.equal(resolution.decision, "deny");
  assert.equal(resolution.resolvedBy, "gateway-client");
  const deniedRecord = (await approver.call("approval.history", {})).items.find(
    (i) => i.id === denied.request.id,
  );
  t.diagnostic(`approval.history denied=${JSON.stringify(deniedRecord)}`);
  // History tells a human deny from expiry and cancellation, with the decision.
  assert.equal(deniedRecord.status, "denied");
  assert.equal(deniedRecord.decision, "deny");

  // allow-always runs and adds an exact-command entry for the agent.
  await decide(
    gw,
    approver,
    await run("always", `touch ${at("always")}`),
    "allow-always",
  );
  assert.equal(fs.existsSync(at("always")), true);
  const always = await policy();
  t.diagnostic(`after allow-always=${JSON.stringify(always.file.agents)}`);
  const entries = always.file.agents.main.allowlist;
  const entry = entries.find((e) => e.pattern === touch);
  assert.equal(entry.source, "allow-always");
  assert.match(entry.argPattern, /^sha256:cwd-argv:v1:[0-9a-f]{64}$/);
  assert.equal(typeof entry.id, "string");
  assert.equal(entry.lastUsedCommand, undefined, "the entry does not carry the command");
  // A companion entry without a path; it is not what grants the command.
  assert.deepEqual(
    entries.filter((e) => e !== entry).map((e) => e.pattern.replace(/[0-9a-f]+$/, "")),
    ["=node-command:"],
  );
  fs.rmSync(at("always"));
  await silent(gw, approver, await run("always-again", `touch ${at("always")}`));
  assert.equal(fs.existsSync(at("always")), true, "the same command runs unasked");
  // Different arguments are a different command.
  const other = await decide(
    gw,
    approver,
    await run("other", `touch ${at("o")}`),
    "deny",
  );
  assert.ok(other.request, "other arguments ask");

  // Deleting the path entry through exec.approvals.set restores the prompt. The
  // base hash must be current: every use updates lastUsedAt and so the hash.
  const current = await policy();
  assert.notEqual(current.hash, always.hash);
  const stale = await answer(
    approver.call("exec.approvals.set", { baseHash: always.hash, file: always.file }),
  );
  assert.deepEqual([stale.code, stale.answered], ["INVALID_REQUEST", true]);
  const kept = current.file.agents.main.allowlist.filter((e) => e.id !== entry.id);
  const written = await approver.call("exec.approvals.set", {
    baseHash: current.hash,
    file: {
      ...current.file,
      agents: { main: { ...current.file.agents.main, allowlist: kept } },
    },
  });
  assert.deepEqual(
    written.file.agents.main.allowlist.map((e) => e.id),
    kept.map((e) => e.id),
  );
  fs.rmSync(at("always"));
  const removed = await decide(
    gw,
    approver,
    await run("rm", `touch ${at("always")}`),
    "deny",
  );
  assert.ok(removed.request, "a deleted entry asks again");
  assert.equal(fs.existsSync(at("always")), false);

  // An entry written without argPattern allows the executable with any arguments.
  const before = await policy();
  await approver.call("exec.approvals.set", {
    baseHash: before.hash,
    file: { ...before.file, agents: { main: { allowlist: [{ pattern: touch }] } } },
  });
  await silent(gw, approver, await run("manual", `touch ${at("manual")}`));
  assert.equal(fs.existsSync(at("manual")), true);
  // A pipeline needs every segment allowlisted.
  const piped = await decide(
    gw,
    approver,
    await run("pipe", `touch ${at("p")} | cat`),
    "deny",
  );
  assert.ok(piped.request);
  assert.equal(fs.existsSync(at("p")), false);
});

// AgentPier's answer to a withheld allow-always (exec-decisions.js): allow-once,
// then one program-path entry per program where exec-allowlist-policy.js allows.
test(
  "AgentPier's program entries cover pipelines but never interpreters",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "shell-fallback-" });
    const bin = path.join(gw.dataDir, "owner-tools");
    const mark = path.join(bin, "mark");
    const sink = path.join(bin, "sink");
    const node = fs.realpathSync(path.join(installed, "node/bin/node"));
    const at = (name) => path.join(gw.dataDir, name);
    fs.mkdirSync(bin);
    fs.writeFileSync(mark, '#!/bin/sh\ntouch "$1"\necho marked\n', { mode: 0o755 });
    fs.writeFileSync(sink, '#!/bin/sh\ntouch "$1"\n', { mode: 0o755 });
    fs.writeFileSync(
      at("mark.js"),
      "require('fs').writeFileSync(process.argv[2], '');\n",
    );
    await gw.configure({
      tools: { allow: execTools, exec: { mode: "ask", strictInlineEval: true } },
    });
    const approver = await gw.approver();
    // "Always allow" as decideExec answers it when OpenClaw withholds allow-always.
    const allowAlways = async (label, command) => {
      const run = await gw.send(label, command);
      const { id, request } = await requestFor(approver, run);
      t.diagnostic(
        `${label} allowed=${request.allowedDecisions} analysis=${JSON.stringify(request.commandAnalysis)}`,
      );
      assert.deepEqual(request.allowedDecisions, ["allow-once", "deny"]);
      await approver.call("exec.approval.resolve", { id, decision: "allow-once" });
      const plan = allowAlwaysPlan({
        command: request.command,
        cwd: request.cwd,
        resolvedPath: request.resolvedPath,
        riskKinds: request.commandAnalysis?.riskKinds,
      });
      const written =
        plan.kind === "paths"
          ? await writeExecAllowlistEntry(approver, {
              agentId: request.agentId,
              paths: plan.paths,
            })
          : null;
      await gw.settle(run);
      return { request, plan, written };
    };
    const asks = async (label, command) =>
      !!(await decide(gw, approver, await gw.send(label, command), "deny")).request;

    // OpenClaw denies a redirection with a user-owned program outright, without
    // asking ("approval cannot safely bind this command"); entries change nothing.
    const redirect = async (label, name) =>
      decide(
        gw,
        approver,
        await gw.send(label, `${mark} ${at(name)} > ${at(`${name}.out`)}`),
        "deny",
      );
    const unbound = await redirect("redirect-before", "r0");
    assert.equal(unbound.request, undefined);
    assert.match(unbound.result, /cannot safely bind/);
    // A pipeline of two user-owned programs: one entry each.
    const pipeline = `${mark} ${at("p1")} | ${sink} ${at("p2")}`;
    const piped = await allowAlways("pipeline", pipeline);
    const owned = [fs.realpathSync(mark), fs.realpathSync(sink)];
    assert.deepEqual(piped.plan, { kind: "paths", paths: owned, writable: owned });
    assert.equal(piped.written.written, true);
    assert.equal(piped.written.entries.length, 2);
    assert.equal(fs.existsSync(at("p2")), true);
    fs.rmSync(at("p1"));
    fs.rmSync(at("p2"));
    // The same pipeline, and each program alone with other arguments, run unasked.
    await silent(gw, approver, await gw.send("pipeline-again", pipeline));
    assert.equal(fs.existsSync(at("p2")), true);
    await silent(gw, approver, await gw.send("mark-alone", `${mark} ${at("m")}`));
    assert.equal(fs.existsSync(at("m")), true);
    await silent(gw, approver, await gw.send("sink-alone", `${sink} ${at("s")}`));
    assert.equal(fs.existsSync(at("s")), true);
    const redirected = await redirect("redirect-after", "r");
    assert.equal(redirected.request, undefined);
    assert.match(redirected.result, /cannot safely bind/);
    const { file } = await approver.call("exec.approvals.get", {});
    const agentId = piped.request.agentId;
    assert.deepEqual(
      file.agents[agentId].allowlist.map((e) => [e.pattern, e.source, e.argPattern]),
      piped.plan.paths.map((p) => [p, undefined, undefined]),
    );

    // An interpreter running a script: no entry, the next run asks again.
    const script = `${nodeWord(node)} ${at("mark.js")} ${at("node")}`;
    const interpreted = await allowAlways("interpreter", script);
    assert.deepEqual(interpreted.plan, {
      kind: "once",
      reason: "interpreter",
      program: node,
    });
    assert.equal(fs.existsSync(at("node")), true);
    assert.equal(await asks("interpreter-again", script), true);
    // A pipeline with an interpreter segment: no entries at all.
    const mixed = `${mark} ${at("x")} | ${nodeWord(node)} ${at("mark.js")} ${at("y")}`;
    const mixedRun = await allowAlways("mixed", mixed);
    assert.equal(mixedRun.plan.kind, "once");
    assert.equal(await asks("mixed-again", mixed), true);
    const after = await approver.call("exec.approvals.get", {});
    assert.equal(after.file.agents[agentId].allowlist.length, 2);
  },
);

// AgentPier never writes an any-argument entry for a program OpenClaw itself
// treats as an interpreter, shell, launcher or wrapper. An OpenClaw update that
// adds one, or moves these lists, fails here.
test("AgentPier's interpreter list covers OpenClaw's own lists", options, (t) => {
  const dist = path.join(installed, "app/node_modules/openclaw/dist");
  const files = fs.readdirSync(dist).filter((f) => f.endsWith(".mjs"));
  const source = (prefix) => {
    const found = files.filter((f) => f.startsWith(prefix));
    assert.ok(found.length, `no ${prefix}*.mjs in the dist`);
    return found.map((f) => fs.readFileSync(path.join(dist, f), "utf8")).join("\n");
  };
  const strings = (text) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const between = (text, start, end) => {
    const a = text.indexOf(start);
    assert.ok(a >= 0, `${start} not found`);
    const b = text.indexOf(end, a + start.length);
    assert.ok(b > a, `${end} not found after ${start}`);
    return text.slice(a + start.length, b);
  };
  const lists = {};
  const risks = source("risks-");
  lists.inlineEval = [
    ...between(
      risks,
      "FLAG_INTERPRETER_INLINE_EVAL_SPECS = [",
      "const INTERPRETER_ALLOWLIST_NAMES",
    ).matchAll(/names:\s*\[([^\]]*)\]/g),
  ].flatMap((m) => strings(m[1]));
  const safeBins = source("exec-safe-bin-runtime-policy-");
  lists.safeBins = strings(between(safeBins, "INTERPRETER_LIKE_SAFE_BINS = ", "]);"));
  const binding = source("system-run-approval-binding-");
  for (const name of [
    "PACKAGE_MANAGER_EXECUTABLES",
    "GENERIC_MUTABLE_SCRIPT_RUNNERS",
    "OPAQUE_MUTABLE_SCRIPT_RUNNERS",
  ])
    lists[name] = strings(between(binding, `${name} = `, "]);"));
  const wrappers = source("shell-wrapper-resolution-");
  for (const name of ["COMMAND_CARRIER_EXECUTABLES", "SOURCE_EXECUTABLES"])
    lists[name] = strings(between(wrappers, `${name} = `, "]);"));
  for (const name of [
    "POSIX_SHELL_WRAPPER_NAMES",
    "WINDOWS_CMD_WRAPPER_NAMES",
    "POWERSHELL_WRAPPER_NAMES",
    "SHELL_MULTIPLEXER_WRAPPER_NAMES",
  ])
    lists[name] = strings(between(wrappers, `${name} = [`, "]"));
  lists.dispatch = [
    ...between(wrappers, "DISPATCH_WRAPPER_SPEC_BY_NAME = new Map([", "].map(").matchAll(
      /name: "([^"]+)"/g,
    ),
  ].map((m) => m[1]);
  for (const [name, list] of Object.entries(lists)) {
    assert.ok(list.length, `${name} is empty`);
    const missing = list.filter((n) => !isInterpreter(n));
    assert.deepEqual(missing, [], `${name}: ${missing.join(", ")}`);
  }
  t.diagnostic(`checked ${Object.values(lists).flat().length} names`);
  // OpenClaw's version-suffixed interpreter names.
  for (const name of ["node22", "python3.12", "ruby3.3", "perl5.36", "php8.2"])
    assert.equal(isInterpreter(name), true, name);
});

test("inline evaluation and strictInlineEval", options, async (t) => {
  const gw = await shellGateway(t, installed, { prefix: "shell-inline-" });
  const at = (name) => path.join(gw.dataDir, name);
  const node = fs.realpathSync(path.join(installed, "node/bin/node"));
  const inline = (name) =>
    `${nodeWord(node)} -e "require('fs').writeFileSync('${at(name)}','')"`;
  await gw.configure({ tools: { allow: execTools, exec: { mode: "ask" } } });
  const approver = await gw.approver();

  // Under ask, an inline evaluation asks and never offers allow-always.
  const plain = await decide(
    gw,
    approver,
    await gw.send("plain", inline("plain")),
    "allow-once",
  );
  const asked = plain.request.request;
  t.diagnostic(`inline request=${JSON.stringify(asked)}`);
  assert.deepEqual(asked.allowedDecisions, ["allow-once", "deny"]);
  assert.deepEqual(asked.unavailableDecisions, ["allow-always"]);
  assert.deepEqual(asked.commandAnalysis.riskKinds, ["inline-eval"]);
  assert.equal(asked.warningText, null);
  assert.equal(fs.existsSync(at("plain")), true);

  // With the interpreter allowlisted (no argPattern), only strictInlineEval asks.
  const policy = await approver.call("exec.approvals.get", {});
  await approver.call("exec.approvals.set", {
    baseHash: policy.hash,
    file: { ...policy.file, agents: { main: { allowlist: [{ pattern: node }] } } },
  });
  await silent(gw, approver, await gw.send("listed", inline("listed")));
  assert.equal(fs.existsSync(at("listed")), true);
  await gw.configure({ tools: { exec: { mode: "ask", strictInlineEval: true } } });
  const strict = await decide(gw, approver, await gw.send("strict", inline("s")), "deny");
  t.diagnostic(`strict request=${JSON.stringify(strict.request?.request)}`);
  assert.ok(strict.request, "strictInlineEval asks for an allowlisted interpreter");
  assert.deepEqual(strict.request.request.allowedDecisions, ["allow-once", "deny"]);
  assert.match(strict.request.request.warningText, /strict inline-eval mode requires/);
  assert.equal(fs.existsSync(at("s")), false);

  // Under full, strictInlineEval still asks; without it, full runs unasked.
  await gw.configure({ tools: { exec: { mode: "full", strictInlineEval: true } } });
  const full = await decide(
    gw,
    approver,
    await gw.send("full-strict", inline("fs")),
    "deny",
  );
  assert.ok(full.request, "full with strictInlineEval asks");
  assert.equal(fs.existsSync(at("fs")), false);
  await gw.configure({ tools: { exec: { mode: "full", strictInlineEval: false } } });
  await silent(gw, approver, await gw.send("full-plain", inline("fp")));
  assert.equal(fs.existsSync(at("fp")), true);
});

test("a pending request is cancelled by a Gateway restart", options, async (t) => {
  const gw = await shellGateway(t, installed, { prefix: "shell-restart-" });
  const marker = path.join(gw.dataDir, "pending");
  await gw.configure({ tools: { allow: execTools, exec: { mode: "ask" } } });
  const approver = await gw.approver();
  const run = await gw.send("pending", `touch ${marker}`);
  const request = await requestFor(approver, run);
  const listed = await approver.call("exec.approval.list", {});
  t.diagnostic(`exec.approval.list=${JSON.stringify(listed)}`);
  assert.deepEqual(
    listed.map((a) => [a.id, a.approvalKind, a.request.runId, a.expiresAtMs]),
    [[request.id, "exec", "pending", request.expiresAtMs]],
  );
  await gw.runtime.restart();
  const after = await gw.approver();
  assert.deepEqual(await after.call("exec.approval.list", {}), []);
  const lookup = await answer(after.call("exec.approval.get", { id: request.id }));
  assert.equal(lookup.code, "INVALID_REQUEST");
  const late = await answer(
    after.call("exec.approval.resolve", { id: request.id, decision: "allow-once" }),
  );
  assert.equal(late.code, "INVALID_REQUEST");
  const history = await after.call("approval.history", {});
  const record = history.items.find((i) => i.id === request.id);
  t.diagnostic(`approval.history=${JSON.stringify(record)}`);
  assert.equal(record.status, "cancelled");
  assert.equal(record.reason, "run-aborted");
  assert.equal(record.presentation.commandText, `touch ${marker}`);
  const cancelled = approver.events.find(
    (e) => e.event === "exec.approval.resolved" && e.payload.id === request.id,
  )?.payload;
  t.diagnostic(`cancelled resolved=${JSON.stringify(cancelled)}`);
  // A cancellation is a deny by the system resolver, not by a person.
  assert.equal(cancelled.decision, "deny");
  assert.equal(cancelled.resolvedBy, "approval-scope-closed");
  assert.equal(fs.existsSync(marker), false);
});

test("per-agent exec modes over a global deny", options, async (t) => {
  const gw = await shellGateway(t, installed, { prefix: "shell-modes-" });
  const at = (name) => path.join(gw.dataDir, name);
  await gw.configure({});
  for (const id of ["unset", "asker", "off"]) await gw.agent(id);
  await gw.configure({
    tools: { allow: execTools, exec: { mode: "deny" } },
    agents: {
      entries: {
        main: { tools: { allow: execTools, exec: { mode: "full" } } },
        unset: { tools: { allow: execTools } },
        asker: { tools: { allow: execTools, exec: { mode: "ask" } } },
        off: { tools: { allow: ["session_status"] } },
      },
    },
  });
  const approver = await gw.approver();
  const outcome = {};
  for (const agent of ["main", "unset", "asker", "off"]) {
    const run = await gw.send(`mode-${agent}`, `touch ${at(agent)}`, agent);
    const { request, offered, result } = await decide(
      gw,
      approver,
      run,
      "allow-once",
      10000,
    );
    outcome[agent] = {
      asked: !!request,
      offered: offered.includes("exec"),
      ran: fs.existsSync(at(agent)),
    };
    t.diagnostic(`${agent}=${JSON.stringify({ ...outcome[agent], result })}`);
    if (agent === "unset")
      assert.match(result, /exec denied: host=gateway security=deny/);
  }
  assert.deepEqual(outcome, {
    main: { asked: false, offered: true, ran: true },
    unset: { asked: false, offered: true, ran: false },
    asker: { asked: true, offered: true, ran: true },
    off: { asked: false, offered: false, ran: false },
  });
});

test(
  "exec and process join the global allow list in team mode without a restart",
  options,
  async (t) => {
    let store, bridge;
    const gw = await shellGateway(t, installed, {
      prefix: "shell-team-",
      setup: (runtime, dataDir) => {
        store = new AssistantStore({ dataDir });
        bridge = new TeamBridge({
          assistants: { store, ledger: new RequestLedger(store.db), runtime },
          generation: () => runtime.generation,
          teams: { store: { context: () => ({ kind: "owner" }) } },
        });
        t.after(async () => {
          await bridge.close();
          store.close();
        });
        runtime.teamConfiguration = async (descriptor) => ({
          ...provisionTeamPlugin({
            paths: runtime.paths,
            runtimeVersion: descriptor.version,
          }),
          connection: await bridge.start(),
          hostMaxConcurrent: 4,
          native: { token: "shell-fixture" },
          profiles: [],
        });
      },
    });
    const marker = path.join(gw.dataDir, "team");
    const { config } = await gw.client.call("config.get", {});
    assert.deepEqual(config.plugins.allow, ["agentpier-teams", "openai", "memory-core"]);
    assert.equal(config.tools.allow.includes("exec"), false);
    for (const key of ["tools.allow", "tools.exec", "agents.entries.*.tools.exec"]) {
      const lookup = await gw.client.call("config.schema.lookup", { path: key });
      assert.equal(lookup.reloadKind, "hot", key);
    }
    await gw.configure({});
    const generation = gw.runtime.generation;
    await gw.configure({
      tools: {
        allow: [...config.tools.allow, "exec", "process"],
        exec: { mode: "deny" },
      },
      agents: {
        entries: { main: { tools: { allow: execTools, exec: { mode: "full" } } } },
      },
    });
    // The next write still succeeds (no pending recovery restart), and exec runs.
    await gw.configure({ agents: { defaults: { timeoutSeconds: 601 } } });
    const { offered } = await gw.turn("team-exec", `touch ${marker}`);
    assert.ok(offered.includes("exec") && offered.includes("process"));
    assert.equal(fs.existsSync(marker), true);
    assert.equal(gw.runtime.generation, generation, "no restart");
    assert.equal(gw.runtime.status().availability, "ready");
  },
);
