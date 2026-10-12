import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFixture } from "../helpers/assistant-exec-fixture.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

test("an interpreter, inline script or unpinnable command is allowed once, without an entry", async (t) => {
  const f = await execFixture(t);
  const tool = f.program("tool");
  const de = serverCatalogs.de.assistants;
  const cases = [
    ["interp", { command: "node build.js" }, { reason: "interpreter", program: "node" }],
    [
      "inline",
      { command: `${tool} x`, commandAnalysis: { riskKinds: ["inline-eval"] } },
      { reason: "inline" },
    ],
    ["complex", { command: `${tool} $(id)` }, { reason: "complex" }],
    [
      "missing",
      { command: `${tool} x | no-such-tool-here y` },
      { reason: "unresolved", program: "no-such-tool-here" },
    ],
  ];
  for (const [id, request, expected] of cases) {
    const action = await f.request(
      id,
      { resolvedPath: tool, ...request, allowedDecisions: ["allow-once", "deny"] },
      f.telegram,
    );
    assert.deepEqual(action.allowAlwaysPlan, { kind: "once", ...expected }, id);
    const decided = await f.workflows.decide(
      action.id,
      { revision: action.revision, decision: "allow-always" },
      { kind: "owner" },
    );
    assert.deepEqual(f.resolves().at(-1), { id, decision: "allow-once" });
    assert.deepEqual(decided.result.allowlist, {
      written: false,
      skipped: expected.reason,
      ...(expected.program ? { program: expected.program } : {}),
    });
  }
  assert.equal(
    f.gateway.calls.some((c) => c.method.startsWith("exec.approvals.")),
    false,
    "no entry is written",
  );
  assert.deepEqual(
    f.decisions().map((d) => [d.allowlist, d.allowlistReason]),
    cases.map(([, , { reason }]) => ["skipped", reason]),
  );
  await f.workflows.tick();
  await f.workflows.tick();
  const results = f.service.outbox.all().filter((e) => e.kind === "action-result");
  assert.equal(results.length, cases.length);
  for (const text of [
    de.execAllowlistSkipped(de.execOnceReasons.interpreter("`node`")),
    de.execAllowlistSkipped(de.execOnceCommandReasons.inline),
    de.execAllowlistSkipped(de.execOnceCommandReasons.complex),
    de.execAllowlistSkipped(de.execOnceReasons.unresolved("`no-such-tool-here`")),
  ]) {
    const notice = results.find((e) => e.text.includes(text));
    assert.ok(notice, text);
    assert.ok(notice.text.startsWith(de.execDecided["allow-once"]));
  }
});

test("a pipeline gets one program entry per program, in one write", async (t) => {
  const f = await execFixture(t);
  const [a, b] = [f.program("first"), f.program("second")];
  let file = { version: 1 };
  f.gateway.answers["exec.approvals.get"] = () => ({ file, hash: "h" });
  f.gateway.answers["exec.approvals.set"] = (params) => {
    file = params.file;
    return { file, hash: "h2" };
  };
  const action = await f.request(
    "pipe",
    {
      command: `${a} x | ${b} y && ${a} z 2>&1`,
      resolvedPath: a,
      allowedDecisions: ["allow-once", "deny"],
    },
    f.telegram,
  );
  assert.deepEqual(action.allowAlwaysPlan, {
    kind: "paths",
    paths: [a, b],
    writable: [a, b],
  });
  const de = serverCatalogs.de.assistants;
  const [notice] = f.service.outbox.all().filter((e) => e.kind === "action-approval");
  assert.ok(notice.text.includes(de.execAllowAlwaysPrograms(`\`${a}\`, \`${b}\``)));
  const decided = await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "allow-always" },
    { kind: "owner" },
  );
  assert.equal(
    f.gateway.calls.filter((c) => c.method === "exec.approvals.set").length,
    1,
  );
  const list = file.agents[f.agent.runtimeAgentId].allowlist;
  assert.deepEqual(
    list.map((e) => e.pattern),
    [a, b],
  );
  assert.deepEqual(
    decided.result.allowlist.entries,
    list.map((e) => ({ entryId: e.id, pattern: e.pattern })),
  );
  assert.deepEqual(
    f.decisions()[0].allowlistEntryIds,
    list.map((e) => e.id),
  );
  await f.workflows.tick();
  await f.workflows.tick();
  const [result] = f.service.outbox.all().filter((e) => e.kind === "action-result");
  assert.ok(result.text.startsWith(de.execDecided["allow-always"]));
  assert.ok(result.text.includes(de.execAllowlistPrograms(`\`${a}\`, \`${b}\``)));
});

test("an expired exec action takes its outcome from the Gateway, not the clock", async (t) => {
  const f = await execFixture(t);
  const ran = await f.request("ran");
  const lapsed = await f.request("lapsed");
  for (const a of [ran, lapsed])
    f.workflows.store.patch(a.id, { expiresAt: Date.now() - 1 });
  // The Gateway accepted a decision whose reply was lost; the other one expired.
  f.gateway.answers["approval.history"] = {
    items: [
      { id: "ran", status: "allowed", decision: "allow-once" },
      { id: "lapsed", status: "expired" },
    ],
  };
  await f.workflows.tick();
  await f.workflows.exec.syncing;
  assert.equal(f.workflows.get(ran.id).state, "completed");
  assert.deepEqual(f.workflows.get(ran.id).result, { decision: "allow-once" });
  assert.equal(f.workflows.get(lapsed.id).state, "expired");
});

test("an expired exec action ends by the clock while the Gateway is away", async (t) => {
  const f = await execFixture(t);
  const down = await f.request("down");
  const stale = await f.request("stale");
  f.workflows.store.patch(down.id, { expiresAt: Date.now() - 1 });
  // Past the grace the Gateway had to report, the clock decides as well.
  f.workflows.store.patch(stale.id, { expiresAt: Date.now() - 120000 });
  f.gateway.answers["exec.approval.list"] = [
    { id: "stale", approvalKind: "exec", request: {} },
  ];
  await f.workflows.tick();
  assert.equal(f.workflows.get(stale.id).state, "expired");
  f.gateway.ready = false;
  await f.workflows.tick();
  assert.equal(f.workflows.get(down.id).state, "expired");
});

test("the decision writes the plan stored with the request, not a new one", async (t) => {
  const f = await execFixture(t);
  const tool = f.program("tool");
  let file = { version: 1 };
  f.gateway.answers["exec.approvals.get"] = () => ({ file, hash: "h" });
  f.gateway.answers["exec.approvals.set"] = (params) => {
    file = params.file;
    return { file, hash: "h2" };
  };
  const action = await f.request("frozen", {
    command: `${tool} x`,
    resolvedPath: tool,
    allowedDecisions: ["allow-once", "deny"],
  });
  // The program changes after the owner saw the plan; the plan does not.
  fs.rmSync(tool);
  const decided = await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "allow-always" },
    { kind: "owner" },
  );
  assert.deepEqual(
    decided.result.allowlist.entries.map((e) => e.pattern),
    [tool],
  );
});
