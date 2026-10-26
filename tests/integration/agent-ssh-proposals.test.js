import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { leadShareFixture } from "../helpers/lead-share-fixture.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { SshManagement } from "../../server/features/ssh/ssh-management.js";
import { invokeSshAccess } from "../../server/features/assistants/agent-ssh-proposals.js";
import { pairedTelegram } from "../../server/features/assistants/team-coding.js";
import {
  lockedTools,
  profileTools,
  routineTools,
} from "../../server/features/assistants/native-capabilities.js";
import { nativeTools } from "../../server/features/assistants/runtime-config.js";
import {
  actions,
  bridgeTool,
  routineActions,
} from "../../server/features/assistants/team-bridge-actions.js";
import { hookActions } from "../../server/features/assistants/agent-hook-bridge.js";
import plugin, {
  toolTimeouts,
} from "../../server/features/assistants/team-plugin/index.js";

const manifest = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../server/features/assistants/team-plugin/openclaw.plugin.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

// A host key pair the stand-in ssh-keyscan reports; never a real host.
function hostKey(root, name) {
  const file = path.join(root, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);
  return fs.readFileSync(`${file}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
}

const proposal = {
  action: "propose",
  name: "Backup NAS",
  host: "nas.example.test",
  port: 2222,
  username: "backup",
  purpose: "Check the nightly backup logs.",
};

// The real workflows (Telegram paired, in German) with a real SSH catalog in a
// disposable data directory. ssh-keyscan is a stand-in that reports `scan.key` for
// any host; key generation and fingerprints run the local ssh-keygen.
async function setup(t) {
  const f = await workflowFixture(t);
  const audit = [];
  f.services.audit = { append: (event) => audit.push(auditEvent(event)) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-proposal-"));
  const keys = [hostKey(root, "host-a"), hostKey(root, "host-b")];
  const management = new SshManagement({
    dataDir: path.join(root, "data"),
    home: root,
    audit: f.services.audit,
    projectRegistry: { projects: () => f.memory.projects() },
  });
  await management.ready;
  t.after(async () => {
    await management.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const scan = { key: keys[0], fail: false, count: 0, args: null };
  const run = management.store.run;
  management.store.run = async (command, args, options) => {
    if (command !== "ssh-keyscan") return run(command, args, options);
    scan.count++;
    scan.args = args;
    if (scan.fail) throw Error("unreachable");
    return { stdout: `# banner\n${args.at(-1)} ${scan.key}\n`, stderr: "" };
  };
  f.services.sshManagement = management;
  const followUps = [];
  const send = f.assistants.send;
  f.assistants.send = async (id, input, context) => {
    if (context?.kind === "ssh-access-result") followUps.push({ id, input, context });
    return send(id, input, context);
  };
  const call = async (input, origin = { kind: "owner" }) =>
    invokeSshAccess(f.workflows, await f.invocation(randomUUID(), origin), input);
  const pending = () =>
    f.workflows.store
      .list(f.id)
      .filter((a) => a.payload.action === "ssh_access")
      .at(-1);
  const texts = () => f.service.outbox.all(f.channel.id).map((e) => e.text);
  const decide = (action, decision, extra = {}, origin = { kind: "owner" }) =>
    f.workflows.decide(
      action.id,
      { revision: action.revision, decision, ...extra },
      origin,
    );
  const catalog = () => ({
    hosts: management.store.list(),
    keys: management.store.keyStore.list(),
  });
  const grants = () => f.workflows.access.get(f.id).sshAccesses;
  return {
    ...f,
    audit,
    management,
    keys,
    scan,
    followUps,
    call,
    pending,
    texts,
    decide,
    catalog,
    grants,
  };
}

const empty = { hosts: [], keys: [] };
// No audit record ever holds the purpose, the host key or a public key.
function assertQuietAudit(f) {
  const text = JSON.stringify(f.audit);
  for (const secret of [proposal.purpose, ...f.keys.map((k) => k.split(" ")[1])])
    assert.ok(!text.includes(secret), secret);
  assert.ok(!/ssh-ed25519/.test(text));
}

test("a proposal scans the host key and asks the owner, creating nothing", async (t) => {
  const f = await setup(t);
  const result = await f.call(proposal);
  assert.equal(result.status, "approval_requested");
  const action = f.pending();
  assert.equal(result.proposalId, action.id);
  assert.equal(action.state, "awaiting_approval");
  assert.match(result.hostFingerprint, /^SHA256:/);
  // ssh-keyscan got the port and the host after its options, nothing else.
  assert.deepEqual(f.scan.args, [
    "-T",
    "5",
    "-p",
    "2222",
    "-t",
    "ed25519,ecdsa,rsa",
    "nas.example.test",
  ]);
  assert.deepEqual(action.payload, {
    action: "ssh_access",
    approval: true,
    name: "Backup NAS",
    host: "nas.example.test",
    port: 2222,
    username: "backup",
    purpose: proposal.purpose,
    projectId: null,
    projectName: null,
    hostKey: f.keys[0],
    hostFingerprint: result.hostFingerprint,
  });
  assert.deepEqual(action.telegram, pairedTelegram(f.workflows, f.id));
  assert.deepEqual(f.catalog(), empty);
  assert.deepEqual(f.grants(), []);
  // The paired Telegram chat shows endpoint, purpose and fingerprint with the note.
  const [card] = f.service.outbox.all(f.channel.id);
  assert.match(card.text, /Backup NAS/);
  assert.match(card.text, /backup@nas\.example\.test, Port 2222/);
  assert.match(card.text, /nightly backup logs/);
  assert.ok(card.text.includes(result.hostFingerprint));
  assert.match(card.text, /Weg, dem du vertraust/);
  assert.deepEqual(
    card.actions.map((a) => [a.decision, a.label]),
    [
      ["approve", "Zugang bestätigen"],
      ["decline", "Aktion ablehnen"],
    ],
  );
  const proposed = f.audit.find((e) => e.action === "ssh.proposed");
  assert.equal(proposed.details.proposalId, action.id);
  assert.equal(proposed.details.assistantId, f.id);
  assertQuietAudit(f);
  // status reports it waiting; the agent never sees a key or the host key itself.
  const { proposals } = await f.call({ action: "status" });
  assert.deepEqual(
    proposals.map((p) => [p.proposalId, p.state, p.hostFingerprint]),
    [[action.id, "awaiting_approval", result.hostFingerprint]],
  );
});

test("approving registers a managed key, the pinned host and an approval grant", async (t) => {
  const f = await setup(t);
  await f.call(proposal);
  const action = f.pending();
  const decided = await f.decide(action, "approve");
  assert.equal(decided.state, "completed");
  assert.equal(f.scan.count, 2, "the host key is read again before anything is written");
  const [host] = f.management.store.list();
  assert.equal(host.name, "Backup NAS");
  assert.equal(host.host, "nas.example.test");
  assert.equal(host.port, 2222);
  assert.equal(host.username, "backup");
  assert.equal(host.hostKey, f.keys[0]);
  assert.equal(host.hostFingerprint, action.payload.hostFingerprint);
  // The owner's verification is the pin's provenance.
  assert.equal(host.trustSource, "user");
  assert.equal(host.projectId, null);
  const [key] = f.management.store.keyStore.list();
  assert.equal(host.keyId, key.id);
  assert.deepEqual(f.grants(), [{ accessId: host.id, mode: "approval" }]);
  assert.deepEqual(decided.result, {
    accessId: host.id,
    hostName: "Backup NAS",
    keyId: key.id,
    keyName: key.name,
    publicKey: key.publicKey,
    keyFingerprint: key.fingerprint,
    keyCreated: true,
    mode: "approval",
  });
  assert.match(key.publicKey, /^ssh-ed25519 /);
  // The outcome reaches Telegram with the key to install, and the agent once.
  await f.workflows.tick();
  assert.equal(f.workflows.store.get(action.id).settled, true);
  const texts = f.texts();
  assert.equal(texts.length, 2);
  assert.match(texts[1], /SSH-Zugang angelegt/);
  assert.ok(texts[1].includes(key.publicKey));
  assert.ok(!texts.join("\n").includes("PRIVATE KEY"));
  assert.equal(f.followUps.length, 1);
  assert.match(f.followUps[0].input.text, /confirmed your proposed SSH access/);
  assert.ok(f.followUps[0].input.text.includes(key.publicKey));
  assert.ok(f.followUps[0].input.text.includes(host.id));
  await f.workflows.tick();
  assert.equal(f.followUps.length, 1);
  const { proposals } = await f.call({ action: "status" });
  assert.deepEqual(proposals[0], {
    proposalId: action.id,
    state: "completed",
    name: "Backup NAS",
    host: "nas.example.test",
    port: 2222,
    username: "backup",
    hostFingerprint: action.payload.hostFingerprint,
    accessId: host.id,
    mode: "approval",
    publicKey: key.publicKey,
  });
  const accepted = f.audit.find((e) => e.action === "ssh.accepted");
  assert.deepEqual(accepted.details, {
    assistantId: f.id,
    accessId: host.id,
    mode: "approval",
    proposalId: action.id,
  });
  const grant = f.audit.find((e) => e.details.kind === "ssh-grants");
  assert.deepEqual(grant.details.added, [host.id]);
  assert.equal(grant.details.reason, "proposal");
  assert.ok(f.audit.some((e) => e.action === "ssh.created" && e.resourceId === host.id));
  assert.ok(
    f.audit.some(
      (e) => e.action === "assistant.answered" && e.details.decision === "approve",
    ),
  );
  assertQuietAudit(f);
  // Decided once: the same button again is a conflict.
  await assert.rejects(f.decide(action, "approve"), { status: 409 });
});

test("the owner picks a project key and another mode in his browser only", async (t) => {
  const f = await setup(t);
  const deploy = await f.management.ui("createKey", {
    name: "Deploy",
    projectId: f.project.id,
  });
  const other = await f.management.ui("createKey", { name: "Global" });
  await f.call({ ...proposal, projectId: f.project.id });
  const action = f.pending();
  assert.equal(action.payload.projectId, f.project.id);
  assert.equal(action.payload.projectName, f.project.name);
  const telegram = { kind: "telegram", ...pairedTelegram(f.workflows, f.id) };
  await assert.rejects(f.decide(action, "approve", { mode: "trusted" }, telegram), {
    key: "invalid",
  });
  // A key of another project, an unknown key or mode leave the proposal open.
  await assert.rejects(f.decide(action, "approve", { keyId: other.id }), {
    key: "sshProposalKey",
  });
  await assert.rejects(f.decide(action, "approve", { keyId: "missing" }), {
    key: "sshProposalKey",
  });
  await assert.rejects(f.decide(action, "approve", { mode: "always" }), {
    key: "invalid",
  });
  assert.equal(f.pending().state, "awaiting_approval");
  assert.equal(f.catalog().hosts.length, 0);
  const decided = await f.decide(action, "approve", {
    keyId: deploy.id,
    mode: "trusted",
  });
  assert.equal(decided.state, "completed");
  const [host] = f.management.store.list();
  assert.equal(host.keyId, deploy.id);
  assert.equal(host.projectId, f.project.id);
  assert.equal(decided.result.keyCreated, false);
  assert.equal(decided.result.publicKey, deploy.publicKey);
  assert.equal(f.catalog().keys.length, 2, "no extra key");
  assert.deepEqual(f.grants(), [{ accessId: host.id, mode: "trusted" }]);
});

test("declining or expiry leave no key, host or grant behind", async (t) => {
  const f = await setup(t);
  await f.call(proposal);
  const declined = await f.decide(f.pending(), "decline");
  assert.equal(declined.state, "declined");
  await f.call({ ...proposal, name: "Second", port: 22 });
  const late = f.pending();
  f.workflows.store.patch(late.id, { expiresAt: Date.now() - 1 });
  await f.workflows.tick();
  assert.equal(f.workflows.store.get(late.id).state, "expired");
  assert.deepEqual(f.catalog(), empty);
  assert.deepEqual(f.grants(), []);
  assert.equal(f.scan.count, 2, "no scan after the proposals");
  assert.ok(f.audit.some((e) => e.action === "ssh.denied" && e.details.proposalId));
  assert.ok(f.audit.some((e) => e.action === "ssh.expired"));
  // The agent hears both outcomes, without a key.
  assert.equal(f.followUps.length, 2);
  assert.match(f.followUps[0].input.text, /was not created \(declined\)/);
  assert.match(f.followUps[1].input.text, /was not created \(expired\)/);
  for (const { input } of f.followUps) assert.ok(!input.text.includes("ssh-ed25519"));
  const texts = f.texts();
  assert.ok(texts.some((text) => /abgelehnt/.test(text)));
  assert.ok(texts.some((text) => /abgelaufen/.test(text)));
  assertQuietAudit(f);
});

test("a host key that changed before approval refuses it; an unreachable host waits", async (t) => {
  const f = await setup(t);
  await f.call(proposal);
  const action = f.pending();
  f.scan.fail = true;
  await assert.rejects(f.decide(action, "approve"), {
    key: "sshProposalScanFailed",
    status: 502,
  });
  assert.equal(f.pending().state, "awaiting_approval");
  f.scan.fail = false;
  f.scan.key = f.keys[1];
  const failed = await f.decide(f.pending(), "approve");
  assert.equal(failed.state, "failed");
  assert.equal(failed.diagnostic, "HOST_KEY_CHANGED");
  assert.deepEqual(f.catalog(), empty);
  assert.deepEqual(f.grants(), []);
  const record = f.audit.find((e) => e.action === "ssh.failed");
  assert.equal(record.outcome, "failure");
  assert.equal(record.details.code, "SSH_HOST_KEY_CHANGED");
  await f.workflows.tick();
  assert.match(f.followUps[0].input.text, /HOST_KEY_CHANGED/);
  assert.ok(f.texts().some((text) => /anderen Schlüssel/.test(text)));
});

test("existing hosts, unknown projects, failed scans and the rate limit are refused", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.call({ ...proposal, projectId: "missing" }), {
    key: "sshProposalProject",
    status: 404,
  });
  await assert.rejects(f.call({ ...proposal, host: "-oProxyCommand=id" }), {
    key: "sshProposalInvalid",
  });
  assert.equal(f.scan.count, 0, "invalid input never reaches ssh-keyscan");
  // The owner already has this endpoint.
  await f.management.ui("createHost", {
    name: "NAS",
    host: proposal.host,
    port: proposal.port,
    username: proposal.username,
    hostKey: f.keys[0],
  });
  await assert.rejects(f.call(proposal), { key: "sshProposalExists", status: 409 });
  // Two waiting proposals are the limit.
  await f.call({ ...proposal, username: "ops" });
  await f.call({ ...proposal, username: "audit" });
  await assert.rejects(f.call({ ...proposal, username: "logs" }), {
    key: "sshProposalLimit",
    status: 429,
  });
  for (const a of f.workflows.store.list(f.id))
    if (a.state === "awaiting_approval") await f.decide(a, "decline");
  // Failed scans count toward the hourly limit with the proposals.
  f.scan.fail = true;
  for (const username of ["a1", "a2", "a3"])
    await assert.rejects(f.call({ ...proposal, username }), {
      key: "sshProposalScanFailed",
      status: 502,
    });
  f.scan.fail = false;
  await assert.rejects(f.call({ ...proposal, username: "a4" }), {
    key: "sshProposalLimit",
  });
  assert.equal(f.catalog().hosts.length, 1);
});

test("forwarded, routine and member turns never propose", async (t) => {
  const f = await setup(t);
  for (const origin of [
    { kind: "owner", forwarded: true },
    { kind: "member-result", requestId: "r" },
    { kind: "lead-request", requestId: "r" },
  ])
    await assert.rejects(f.call(proposal, origin), {
      key: "sshProposalOwnerOnly",
      status: 403,
    });
  const run = { attemptId: null, toolCallId: "call", assertCurrent() {} };
  await assert.rejects(
    invokeSshAccess(f.workflows, { ...run, routine: { binding: { id: "b" } } }, proposal),
    { key: "sshProposalOwnerOnly" },
  );
  // A Telegram turn of the owner proposes; its own chat gets the card.
  const result = await f.call(proposal, {
    kind: "telegram",
    ...pairedTelegram(f.workflows, f.id),
  });
  assert.equal(result.status, "approval_requested");
  assert.equal(f.scan.count, 1);
});

test("a grant that cannot be written takes the new host and key away again", async (t) => {
  const f = await setup(t);
  await f.call(proposal);
  const grant = f.workflows.access.grantSsh;
  f.workflows.access.grantSsh = () => {
    throw Object.assign(Error("busy"), { status: 409 });
  };
  const failed = await f.decide(f.pending(), "approve");
  f.workflows.access.grantSsh = grant;
  assert.equal(failed.state, "failed");
  assert.equal(failed.diagnostic, "AGENT_UNAVAILABLE");
  assert.deepEqual(f.catalog(), empty);
  assert.deepEqual(f.grants(), []);
  // An agent that got a bot for other people meanwhile never gets the access.
  await f.call({ ...proposal, username: "ops" });
  f.services.assistantTelegramSenders = { connected: () => true };
  const refused = await f.decide(f.pending(), "approve");
  assert.equal(refused.diagnostic, "AGENT_UNAVAILABLE");
  assert.equal(f.scan.count, 3, "refused before the host is read again");
  assert.deepEqual(f.catalog(), empty);
});

test("agentpier_ssh_access is compiled for own agents and permanent members only", () => {
  const tools = (agent) => profileTools({ capabilities: {}, ...agent }, true, true, true);
  assert.ok(tools({ id: "a" }).includes("agentpier_ssh_access"));
  assert.ok(
    tools({ id: "a", teamMemberId: "m", lifetime: "permanent" }).includes(
      "agentpier_ssh_access",
    ),
  );
  for (const agent of [
    { id: "a", teamMemberId: "m", lifetime: "task" },
    { id: "a", archivedAt: "2026-10-20" },
    { id: "a", userAccess: { mode: "shared", members: [], released: [] } },
  ])
    assert.ok(!tools(agent).includes("agentpier_ssh_access"), JSON.stringify(agent));
  assert.ok(!routineTools.includes("agentpier_ssh_access"));
  assert.ok(!routineActions.has("ssh_access"));
  assert.ok(!hookActions.has("ssh_access"));
  assert.ok(actions.has("ssh_access"));
  assert.equal(bridgeTool("ssh_access"), "agentpier_ssh_access");
  assert.ok(nativeTools.includes("agentpier_ssh_access"));
  assert.ok(lockedTools.includes("agentpier_ssh_access"));
  assert.ok(manifest.contracts.tools.includes("agentpier_ssh_access"));
  // The plugin registers it with a strict schema and room for the host key scan.
  const registered = new Map();
  plugin.register({
    pluginConfig: { url: "http://bridge.invalid", token: "test" },
    registerTool: (factory, options) => registered.set(options.name, factory),
    on() {},
  });
  const tool = registered
    .get("agentpier_ssh_access")
    .create({ agentId: "ap-x", sessionKey: "s", assertInvocationCurrent() {} });
  assert.deepEqual(tool.parameters.properties.action.enum, ["propose", "status"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.port.maximum, 65535);
  assert.ok(!("keyId" in tool.parameters.properties));
  assert.ok(toolTimeouts.ssh_access >= 20000);
});

test("a permanent member proposes through the bridge in the owner's own turn", async (t) => {
  const f = await leadShareFixture(t);
  const id = f.member.assistantId;
  // A stand-in catalog: no hosts yet, and a scan that reports one key.
  f.workflows.s.sshManagement = {
    store: {
      list: () => [],
      scan: async () => ({ hostKey: "ssh-ed25519 AAAA", hostFingerprint: "SHA256:x" }),
    },
    projects: async () => ({ projects: [] }),
  };
  f.assistants.runtime.generation = 1;
  const bridge = new TeamBridge({ assistants: f.assistants, teams: {} });
  await bridge.start();
  t.after(() => bridge.close());
  const agentId = f.store.getAssistant(id).runtimeAgentId;
  const call = (input) => {
    const { ticket } = bridge.prepare({
      agentId,
      sessionKey: f.memberChat.runtimeSessionKey,
      toolCallId: randomUUID(),
      action: "ssh_access",
    });
    return bridge.invoke({ ticket, action: "ssh_access", input });
  };
  const owner = await f.turn(f.memberChat.id);
  const result = await call(proposal);
  assert.equal(result.status, "approval_requested");
  const action = f.workflows.store.get(result.proposalId);
  assert.equal(action.assistantId, id);
  assert.equal(action.conversationId, f.memberChat.id);
  assert.equal(action.attemptId, owner.attemptId);
  f.assistants.ledger.transition(owner.attemptId, "completed");
  // The lead's task in the member's chat is no owner turn.
  await f.task();
  await assert.rejects(call({ ...proposal, username: "ops" }), (error) => {
    assert.equal(toolError(error).code, "SSH_PROPOSAL_OWNER_ONLY");
    return true;
  });
});
