import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";
import { fakeGithub, githubIssue } from "../helpers/ticket-fakes.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const run = promisify(execFile);
const copy = serverMessages.tickets;
const SESSION = { tool: "claude", accountId: "a1" };
const ruleBody = (extra = {}) => ({
  source: "github",
  label: "agent",
  kind: "session",
  allowMerge: false,
  session: SESSION,
  ...extra,
});

/**
 * The application with a GitHub-linked project whose ticket reads go to a fake GitHub.
 * Rule polling is off: the owner routes are under test, not the monitor.
 */
async function ruleApp(t) {
  const github = await fakeGithub(t, { issues: [githubIssue(12)] });
  const f = await applicationFixture(t, {
    ticketFetch: github.fetchImpl,
    ticketSequences: { intervalMs: 0 },
    ticketRules: { intervalMs: 0 },
  });
  await run("git", ["init", "-q", "-b", "main"], { cwd: f.project });
  await run("git", ["remote", "add", "origin", "https://github.com/acme/app.git"], {
    cwd: f.project,
  });
  const project = await f.application.memory.register(f.project);
  const created = await f.request("/api/git-credentials", {
    method: "POST",
    body: { name: "Work", host: "github.com", token: "gh-token" },
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  await f.request(`/api/git-credentials/${id}`, {
    method: "PATCH",
    body: { agentDefault: true },
  });
  const responses = [];
  const call = async (endpoint, options) => {
    const response = await f.request(endpoint, options);
    const text = await response.text();
    responses.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const rules = `/api/tickets/projects/${project.id}/rules`;
  return { f, project, call, rules, responses };
}

test("owner creates, lists, edits, pauses and deletes a rule", async (t) => {
  const { f, project, call, rules } = await ruleApp(t);
  const requested = t.mock.method(f.application.ticketRuleMonitor, "request");
  const signals = [];
  const hub = f.application.live;
  const invalidate = hub.invalidate.bind(hub);
  t.mock.method(hub, "invalidate", (name, param) => {
    signals.push([name, param]);
    return invalidate(name, param);
  });
  assert.deepEqual((await call(rules)).body, { rules: [] });

  const created = await call(rules, { method: "POST", body: ruleBody() });
  assert.equal(created.status, 201);
  const { rule } = created.body;
  assert.equal(rule.source, "github");
  assert.equal(rule.label, "agent");
  assert.equal(rule.kind, "session");
  assert.equal(rule.paused, false);
  assert.equal(rule.picked, 0);
  assert.deepEqual(rule.options, { allowMerge: false, session: SESSION });
  assert.deepEqual(rule.status, { checkedAt: null, error: null, capped: false });
  assert.equal("notified" in rule.status, false);
  assert.equal("projectId" in rule, false);
  assert.equal(requested.mock.callCount(), 1);
  assert.deepEqual(
    signals.filter(([name]) => name === "tickets.rules"),
    [["tickets.rules", project.id]],
  );
  assert.deepEqual((await call(rules)).body, { rules: [rule] });

  // A duplicate label (in another spelling) is refused.
  const twice = await call(rules, { method: "POST", body: ruleBody({ label: "Agent" }) });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, copy.ruleExists);

  const edited = await call(`${rules}/${rule.id}`, {
    method: "PUT",
    body: ruleBody({ label: "ready", allowMerge: true }),
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.rule.id, rule.id);
  assert.equal(edited.body.rule.label, "ready");
  assert.equal(edited.body.rule.options.allowMerge, true);
  assert.equal(requested.mock.callCount(), 2);

  // Pause sends the saved rule with `paused` flipped; a paused rule asks for no pass.
  const paused = await call(`${rules}/${rule.id}`, {
    method: "PUT",
    body: ruleBody({ label: "ready", allowMerge: true, paused: true }),
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.rule.paused, true);
  assert.equal(requested.mock.callCount(), 2);
  const resumed = await call(`${rules}/${rule.id}`, {
    method: "PUT",
    body: ruleBody({ label: "ready", allowMerge: true }),
  });
  assert.equal(resumed.body.rule.paused, false);
  assert.equal(requested.mock.callCount(), 3);

  const missing = await call(`${rules}/nope`, { method: "PUT", body: ruleBody() });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, copy.ruleNotFound);

  assert.equal((await call(`${rules}/${rule.id}`, { method: "DELETE" })).status, 204);
  assert.deepEqual((await call(rules)).body, { rules: [] });
  assert.equal((await call(`${rules}/${rule.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await call("/api/tickets/projects/unknown/rules")).status, 404);
});

test("create refuses an unconnected Plane source with 409", async (t) => {
  const { f, call, rules } = await ruleApp(t);
  const refused = await call(rules, {
    method: "POST",
    body: ruleBody({ source: "plane" }),
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, copy.source.notConnected);
  assert.deepEqual(f.application.ticketRuleStore.allRules(), []);
});

test("create refuses an invalid body with 400 and the de message", async (t) => {
  const { f, call, rules } = await ruleApp(t);
  for (const body of [
    ruleBody({ allowMerge: undefined }),
    ruleBody({ allowMerge: "false" }),
    ruleBody({ label: "" }),
    ruleBody({ label: "a,b" }),
    ruleBody({ label: "x".repeat(51) }),
    ruleBody({ source: "jira" }),
    ruleBody({ paused: "yes" }),
    ruleBody({ kind: "robot" }),
    [],
  ]) {
    const refused = await call(rules, { method: "POST", body });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.body.error, copy.invalidRule);
  }
  assert.deepEqual(f.application.ticketRuleStore.allRules(), []);
});

test("responses never contain the GitHub token", async (t) => {
  const { call, rules, responses } = await ruleApp(t);
  const { body } = await call(rules, { method: "POST", body: ruleBody() });
  await call(rules);
  await call(`${rules}/${body.rule.id}`, { method: "PUT", body: ruleBody() });
  await call(rules, { method: "POST", body: ruleBody({ source: "plane" }) });
  assert.ok(responses.length >= 4);
  for (const text of responses) assert.equal(text.includes("gh-token"), false);
});

test("a member gets 403", async (t) => {
  const { f, call, rules } = await ruleApp(t);
  const { body } = await call(rules, { method: "POST", body: ruleBody() });
  const ruleId = body.rule.id;
  const { cookie } = await signedInUser(f);
  const headers = { cookie };
  for (const [method, endpoint, payload] of [
    ["GET", rules],
    ["POST", rules, ruleBody({ label: "other" })],
    ["PUT", `${rules}/${ruleId}`, ruleBody({ paused: true })],
    ["DELETE", `${rules}/${ruleId}`],
  ]) {
    const response = await f.request(endpoint, { method, headers, body: payload });
    // Owner routes answer users like unknown routes (route-access.js).
    assert.ok([403, 404].includes(response.status), `${method} ${endpoint}`);
  }
  const saved = f.application.ticketRuleStore.allRules();
  assert.deepEqual(
    saved.map((rule) => [rule.id, rule.label, rule.paused]),
    [[ruleId, "agent", false]],
  );
});

test("rules survive an application restart", async (t) => {
  const { f, call, rules } = await ruleApp(t);
  const { body } = await call(rules, { method: "POST", body: ruleBody() });
  await f.restart();
  const read = await call(rules);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { rules: [body.rule] });
});

test("a rule file of a newer version keeps the server up with the rules read-only", async (t) => {
  const { f, call, rules } = await ruleApp(t);
  const { body } = await call(rules, { method: "POST", body: ruleBody() });
  const file = path.join(f.dataDir, "ticket-rules.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const content = JSON.stringify({ ...saved, version: 2 });
  fs.writeFileSync(file, content);
  await f.restart();
  const read = await call(rules);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, {
    rules: [],
    locked: { code: "unsupportedVersion", version: 2 },
  });
  for (const [path_, method, body_] of [
    [rules, "POST", ruleBody({ label: "other" })],
    [`${rules}/${body.rule.id}`, "PUT", ruleBody({ paused: true })],
    [`${rules}/${body.rule.id}`, "DELETE"],
  ]) {
    const refused = await call(path_, { method, body: body_ });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "TICKET_RULES_LOCKED");
    assert.equal(refused.body.error, copy.rulesLocked);
  }
  assert.equal(fs.readFileSync(file, "utf8"), content);
});
