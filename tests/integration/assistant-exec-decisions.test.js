import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  execFixture,
  gatewayError,
  settle,
  staleHash,
} from "../helpers/assistant-exec-fixture.js";
import { assistantWorkflowRoutes } from "../../server/http/routes/assistant-workflows.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

test("each decision resolves its own approval id once and ends the action", async (t) => {
  const f = await execFixture(t);
  const owner = { kind: "owner", channel: "ui" };
  const cases = [
    ["a-once", "allow-once", "completed"],
    ["a-always", "allow-always", "completed"],
    ["a-deny", "deny", "declined"],
  ];
  const actions = [];
  for (const [id] of cases) actions.push(await f.request(id));
  for (const [n, [id, decision, state]] of cases.entries()) {
    const action = actions[n];
    assert.equal(action.allowAlwaysByAgentPier, false);
    const decided = await f.workflows.decide(
      action.id,
      { revision: action.revision, decision },
      owner,
    );
    assert.equal(decided.state, state);
    assert.deepEqual(decided.result, { decision });
    assert.deepEqual(f.resolves().at(-1), { id, decision });
    // A second decision is a conflict and never reaches the Gateway.
    await assert.rejects(
      f.workflows.decide(action.id, { revision: action.revision, decision }, owner),
      { status: 409 },
    );
  }
  assert.deepEqual(
    f.resolves().map((r) => r.id),
    ["a-once", "a-always", "a-deny"],
  );
  assert.deepEqual(
    f.decisions().map((d) => [d.outcome, d.kind, d.decision, d.channel]),
    [
      ["success", "exec", "allow-once", "ui"],
      ["failure", "exec", "allow-once", "ui"],
      ["success", "exec", "allow-always", "ui"],
      ["failure", "exec", "allow-always", "ui"],
      ["success", "exec", "deny", "ui"],
      ["failure", "exec", "deny", "ui"],
    ],
  );
  // The Gateway's echo of the decision changes nothing.
  f.emit("exec.approval.resolved", {
    id: "a-once",
    decision: "allow-once",
    resolvedBy: "gateway-client",
  });
  await settle();
  assert.deepEqual(f.workflows.get(actions[0].id).result, { decision: "allow-once" });
});

test("expired and already resolved requests answer 409 and resolve nothing else", async (t) => {
  const f = await execFixture(t);
  const owner = { kind: "owner" };
  const late = await f.request("late");
  const other = await f.request("other");
  f.workflows.store.patch(late.id, { expiresAt: Date.now() - 1 });
  await assert.rejects(
    f.workflows.decide(
      late.id,
      { revision: late.revision, decision: "allow-once" },
      owner,
    ),
    { status: 409 },
  );
  assert.deepEqual(f.resolves(), []);
  // The Gateway no longer knows the request: 409, and a resync ends the action.
  const gone = await f.request("gone");
  f.gateway.answers["exec.approval.resolve"] = gatewayError("INVALID_REQUEST");
  // The Gateway still has the other request.
  f.gateway.answers["exec.approval.list"] = [
    { id: "other", approvalKind: "exec", request: {} },
  ];
  f.gateway.answers["approval.history"] = {
    items: [{ id: "gone", status: "denied", decision: "deny" }],
  };
  await assert.rejects(
    f.workflows.decide(gone.id, { revision: gone.revision, decision: "deny" }, owner),
    { status: 409 },
  );
  await settle();
  await f.workflows.exec.syncing;
  assert.deepEqual(
    f.resolves().map((r) => r.id),
    ["gone"],
  );
  assert.equal(f.workflows.get(gone.id).state, "declined");
  assert.equal(f.workflows.get(other.id).state, "awaiting_approval");
  // A lost connection is not a conflict and leaves the action open.
  const open = await f.request("open");
  f.gateway.answers["exec.approval.resolve"] = Object.assign(Error("closed"), {
    code: "CLOSED",
  });
  await assert.rejects(
    f.workflows.decide(open.id, { revision: open.revision, decision: "deny" }, owner),
    { status: 503 },
  );
  assert.equal(f.workflows.get(open.id).state, "awaiting_approval");
});

test("withheld allow-always resolves allow-once and AgentPier writes the entry", async (t) => {
  const f = await execFixture(t);
  const runtimeId = f.agent.runtimeAgentId;
  let file = {
    version: 1,
    socket: { path: "/sock" },
    agents: { other: { allowlist: [{ id: "keep", pattern: "/bin/ls" }] } },
  };
  let hash = "h1",
    stale = 1;
  f.gateway.answers["exec.approvals.get"] = () => ({ file, hash });
  f.gateway.answers["exec.approvals.set"] = (params) => {
    // The first write races a run that updated lastUsedAt.
    if (stale-- > 0) {
      hash = "h2";
      throw staleHash();
    }
    assert.equal(params.baseHash, hash);
    file = params.file;
    hash = "h3";
    return { file, hash };
  };
  const age = f.program("age");
  const action = await f.request("brew", {
    command: `${age} --version`,
    resolvedPath: age,
    allowedDecisions: ["allow-once", "deny"],
  });
  assert.deepEqual(action.allowAlwaysPlan, {
    kind: "paths",
    paths: [age],
    writable: [age],
  });
  assert.deepEqual(action.payload.allowAlwaysPlan, action.allowAlwaysPlan);
  assert.equal(action.allowAlwaysByAgentPier, true);
  const decided = await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "allow-always" },
    { kind: "owner" },
  );
  assert.deepEqual(f.resolves(), [{ id: "brew", decision: "allow-once" }]);
  assert.equal(decided.state, "completed");
  const entry = file.agents[runtimeId].allowlist[0];
  assert.deepEqual(Object.keys(entry).sort(), ["id", "pattern"]);
  assert.equal(entry.pattern, age);
  assert.deepEqual(file.agents.other, {
    allowlist: [{ id: "keep", pattern: "/bin/ls" }],
  });
  assert.deepEqual(file.socket, { path: "/sock" });
  assert.deepEqual(decided.result, {
    decision: "allow-always",
    resolvedAs: "allow-once",
    allowlist: {
      written: true,
      entries: [{ entryId: entry.id, pattern: age }],
      writable: [age],
    },
  });
  const [record] = f.decisions();
  assert.equal(record.kind, "exec");
  assert.equal(record.decision, "allow-always");
  assert.equal(record.resolvedAs, "allow-once");
  assert.equal(record.allowlist, "written");
  assert.deepEqual(record.allowlistEntryIds, [entry.id]);
  assert.doesNotMatch(JSON.stringify(f.audit), /--version/);
});

test("a failed allowlist write still lets the run proceed and is reported", async (t) => {
  const f = await execFixture(t);
  let sets = 0;
  f.gateway.answers["exec.approvals.get"] = () => ({ file: { version: 1 }, hash: "h" });
  f.gateway.answers["exec.approvals.set"] = () => {
    sets++;
    throw staleHash();
  };
  const tool = f.program("tool");
  const action = await f.request(
    "script",
    {
      command: `${tool} x`,
      resolvedPath: tool,
      allowedDecisions: ["allow-once", "deny"],
    },
    f.telegram,
  );
  const decided = await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "allow-always" },
    { kind: "owner" },
  );
  // Bounded retries, then the failure stays on the action.
  assert.equal(sets, 3);
  assert.deepEqual(f.resolves(), [{ id: "script", decision: "allow-once" }]);
  assert.equal(decided.state, "completed");
  assert.deepEqual(decided.result.allowlist, { written: false, code: "INVALID_REQUEST" });
  const [record] = f.decisions();
  assert.equal(record.outcome, "success");
  assert.equal(record.allowlist, "failed");
  assert.equal(record.allowlistError, "INVALID_REQUEST");
  // The owner hears of it in Telegram, once.
  await f.workflows.tick();
  await f.workflows.tick();
  const results = f.service.outbox.all().filter((e) => e.kind === "action-result");
  assert.equal(results.length, 1);
  const de = serverCatalogs.de.assistants;
  assert.ok(results[0].text.startsWith(de.execDecided["allow-once"]));
  assert.ok(results[0].text.includes(de.execAllowlistFailed));
});

test("Telegram buttons decide exec approvals only from the owner's private chat", async (t) => {
  const f = await execFixture(t);
  let file = { version: 1 };
  f.gateway.answers["exec.approvals.get"] = () => ({ file, hash: "h" });
  f.gateway.answers["exec.approvals.set"] = (params) => {
    file = params.file;
    return { file, hash: "h2" };
  };
  const tool = f.program("tool");
  const action = await f.request(
    "tg",
    {
      command: `${tool} x`,
      resolvedPath: tool,
      allowedDecisions: ["allow-once", "deny"],
    },
    f.telegram,
  );
  const sends = [];
  f.client.call = async (method, input) => {
    sends.push({ method, input });
    return { message_id: sends.length, chat: { id: 42 } };
  };
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  const de = serverCatalogs.de.assistants;
  const sent = sends.find((s) => s.method === "sendMessage").input;
  const buttons = sent.reply_markup.inline_keyboard[0];
  assert.deepEqual(
    buttons.map((b) => b.text),
    [de.execAllowOnce, de.execAllowAlways, de.execDeny],
  );
  const [notice] = f.service.outbox.all().filter((e) => e.kind === "action-approval");
  assert.ok(notice.text.includes(de.execAllowAlwaysPrograms(`\`${tool}\``)));
  assert.ok(notice.text.includes(de.execWritablePrograms(`\`${tool}\``)));
  assert.ok(sent.text.includes(`<code>${tool}</code>`));
  const press = (user, chat = { id: 42, type: "private" }) => ({
    update_id: 2,
    callback_query: {
      id: "callback",
      data: buttons[1].callback_data,
      from: { id: user, is_bot: false },
      message: { message_id: 1, chat },
    },
  });
  // Another user, or the owner in a group, decides nothing.
  await f.service.teamActions.receive(f.channel.id, press(43));
  await f.service.teamActions.receive(f.channel.id, press(42, { id: -5, type: "group" }));
  assert.equal(f.workflows.get(action.id).state, "awaiting_approval");
  assert.deepEqual(f.resolves(), []);
  // A Telegram origin other than the action's own is refused by the workflow too.
  await assert.rejects(
    f.workflows.decide(
      action.id,
      { revision: action.revision, decision: "deny" },
      { ...f.telegram, chatId: "7", userId: "7" },
    ),
    { status: 403 },
  );
  await f.service.teamActions.receive(f.channel.id, press(42));
  assert.deepEqual(f.resolves(), [{ id: "tg", decision: "allow-once" }]);
  assert.equal(f.workflows.get(action.id).state, "completed");
  assert.equal(file.agents[f.agent.runtimeAgentId].allowlist.length, 1);
  const answers = sends.filter((s) => s.method === "answerCallbackQuery");
  assert.equal(answers.at(-1).input.text, de.execDecided["allow-always"]);
  // A second press is stale.
  await f.service.teamActions.receive(f.channel.id, press(42));
  assert.equal(f.resolves().length, 1);
  assert.equal(sends.at(-1).input.text, de.teamDecisionStale);
  const record = f.decisions().find((d) => d.outcome === "success");
  assert.equal(record.channel, "telegram");
  assert.equal(record.allowlist, "written");
});

test("the decision route takes exec decisions and rejects coding ones", async (t) => {
  const f = await execFixture(t);
  const app = express();
  app.use(express.json());
  app.use("/api", assistantWorkflowRoutes({ assistants: f.assistants }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const post = async (id, body) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/assistant-actions/${id}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const action = await f.request("route");
  assert.equal(
    (await post(action.id, { revision: action.revision, decision: "approve" })).status,
    400,
  );
  assert.equal(
    (await post(action.id, { revision: action.revision, decision: "maybe" })).status,
    400,
  );
  const ok = await post(action.id, { revision: action.revision, decision: "allow-once" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.state, "completed");
  assert.equal(ok.body.allowAlwaysByAgentPier, false);
  assert.equal(
    (await post(action.id, { revision: action.revision, decision: "deny" })).status,
    409,
  );
  assert.deepEqual(f.resolves(), [{ id: "route", decision: "allow-once" }]);
});
