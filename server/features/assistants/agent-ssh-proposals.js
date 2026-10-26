import { assistantProblem, textValue } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";
import { directOwnerTurn, goalAgent } from "./goal-turns.js";
import { notifyAction } from "./assistant-action-notifications.js";
import { archived, handOver, pairedTelegram } from "./team-coding.js";
import { sshModes } from "./agent-ssh-origin.js";
import { followUpText, sshProposalCaps } from "./agent-ssh-proposal-notes.js";
import { normalizedEndpoint } from "../ssh/ssh-management-records.js";
import {
  existingHost,
  registerVerifiedHost,
  removeVerifiedHost,
} from "../ssh/ssh-verified-host.js";
import { nameValue } from "../../lib/storage.js";

/**
 * An agent's proposal of a new SSH access (tool `agentpier_ssh_access`, reached
 * through the team bridge). Only a turn of the owner's own message may propose; the
 * agent never registers hosts or handles keys. AgentPier scans the host key (an
 * unverified observation) and asks the owner in an `ssh_access` approval action (chat,
 * paired Telegram, Inbox). Only his approval writes anything: a managed key (or a key
 * he picks), the host pinned to the scanned key as verified by him, and a grant for
 * the agent in mode `approval` (or the mode he picks). A host that shows another key
 * by then fails the proposal. Declined and expired proposals leave nothing behind.
 */
export { sshProposalCaps };
const hourMs = 3600000;
// The session grant limit (ssh-sessions.js) also bounds an agent's SSH hosts.
const maxGrants = 30;
const proposeKeys = [
  "action",
  "name",
  "host",
  "port",
  "username",
  "purpose",
  "projectId",
];
const terminal = new Set(["completed", "failed", "declined", "expired"]);
const ownerOnly = () => assistantProblem("sshProposalOwnerOnly", 403);
// Control characters other than line breaks never reach a card or Telegram; a name
// is one line.
const controls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const breaks = /[\n\u007f-\u009f\u2028\u2029]/;

/**
 * The proposal's fields, checked as the SSH catalog checks an owner's host: a host
 * name or IP address, a port and a user name that can never be read as an option of
 * ssh or ssh-keyscan; a single-line name and a purpose.
 */
export function proposalFields(input) {
  exact(input, proposeKeys);
  let endpoint, name;
  try {
    endpoint = normalizedEndpoint({
      host: input.host,
      port: input.port,
      username: input.username,
    });
    name = nameValue(input.name);
  } catch {
    throw assistantProblem("sshProposalInvalid");
  }
  if (!endpoint.username || breaks.test(name))
    throw assistantProblem("sshProposalInvalid");
  const purpose = textValue(input.purpose, 1000).trim();
  if (controls.test(purpose)) throw assistantProblem("invalid");
  const projectId =
    input.projectId === undefined || input.projectId === null
      ? null
      : textValue(input.projectId, 100);
  return { name, ...endpoint, purpose, projectId };
}

/** An agent that may propose: an own agent or permanent member, no bot for others. */
export const mayPropose = (agent, sendersConnected = false) =>
  goalAgent(agent) && !sendersConnected;

/**
 * Throws while `actions` (the agent's proposals) hold `open` waiting ones, or the
 * proposals and failed scans of the last hour (`attempts`, times) reach `perHour`.
 */
export function proposalLimit(actions, attempts, now = Date.now()) {
  const open = actions.filter(
    (a) => a.state === "awaiting_approval" && a.expiresAt >= now,
  ).length;
  const recent = attempts.filter((time) => now - time < hourMs).length;
  if (open >= sshProposalCaps.open || recent >= sshProposalCaps.perHour)
    throw assistantProblem("sshProposalLimit", 429);
}

/**
 * The owner's own turn behind a tool call, never a routine's or a hook's run, a
 * command's completion, forwarded, member or goal content; throws otherwise.
 */
export function proposalTurn(w, inv) {
  if (!inv.attemptId || inv.routine || inv.hook || inv.continuation) throw ownerOnly();
  const a = w.a,
    attempt = a.ledger.getAttempt(inv.attemptId),
    request = a.ledger.getRequest(attempt.requestId),
    conversation = a.store.getConversation(request.conversationId),
    agent = a.store.getAssistant(conversation.assistantId),
    origin = a.teams.store.context(request.id);
  if (!directOwnerTurn(origin)) throw ownerOnly();
  if (!mayPropose(agent, !!w.s.assistantTelegramSenders?.connected(agent.id)))
    throw assistantProblem("sshProposalUnavailable", 403);
  return { agent, conversation, origin };
}

// Ids, the mode and a stable code only: never the host key, the purpose or a key.
function audit(w, action, a, extra = {}) {
  try {
    w.s.audit?.append({
      action,
      resourceType: "ssh",
      ...(extra.accessId ? { resourceId: extra.accessId } : {}),
      source: ["ssh.accepted", "ssh.denied"].includes(action) ? "user" : "system",
      outcome: action === "ssh.failed" ? "failure" : "success",
      details: { assistantId: a.assistantId, proposalId: a.id, ...extra },
    });
  } catch (error) {
    console.error("SSH access proposal audit failed:", error?.message);
  }
}

const own = (w, id) => w.store.list(id).filter((a) => a.payload.action === "ssh_access");
/** What the agent learns of its proposals: state, and the access once created. */
function status(w, id) {
  return own(w, id)
    .slice(-10)
    .map((a) => ({
      proposalId: a.id,
      state:
        a.state === "awaiting_approval" && a.expiresAt < Date.now() ? "expired" : a.state,
      name: a.payload.name,
      host: a.payload.host,
      port: a.payload.port,
      username: a.payload.username,
      hostFingerprint: a.payload.hostFingerprint,
      ...(a.state === "completed"
        ? {
            accessId: a.result.accessId,
            mode: a.result.mode,
            publicKey: a.result.publicKey,
          }
        : {}),
      ...(a.diagnostic ? { diagnostic: a.diagnostic } : {}),
    }));
}

/** agentpier_ssh_access: `propose` an SSH access for the owner, or its `status`. */
export async function invokeSshAccess(w, inv, input) {
  inv.assertCurrent();
  const management = w?.s.sshManagement;
  if (!management) throw assistantProblem("unavailable", 503);
  const { agent, conversation, origin } = proposalTurn(w, inv);
  if (input?.action === "status") {
    exact(input, ["action"]);
    return { proposals: status(w, agent.id) };
  }
  if (input?.action !== "propose") throw assistantProblem("invalid");
  const fields = proposalFields(input);
  const key = `ssh-access-proposal:${inv.attemptId}:${inv.toolCallId}`;
  const prior = w.store.byKey(key);
  if (prior) return { status: "approval_requested", proposalId: prior.id };
  const now = Date.now(),
    failed = (w.sshProposalScans ??= new Map()),
    scans = (failed.get(agent.id) || []).filter((time) => now - time < hourMs);
  const proposals = own(w, agent.id);
  proposalLimit(proposals, [...proposals.map((a) => Date.parse(a.createdAt)), ...scans]);
  let projectName = null;
  if (fields.projectId) {
    const project = (await management.projects()).projects.find(
      (p) => p.id === fields.projectId,
    );
    if (!project) throw assistantProblem("sshProposalProject", 404);
    projectName = project.name;
  }
  if (existingHost(management, fields)) throw assistantProblem("sshProposalExists", 409);
  let scanned;
  try {
    scanned = await management.store.scan({ host: fields.host, port: fields.port });
  } catch {
    failed.set(agent.id, [...scans, now]);
    throw assistantProblem("sshProposalScanFailed", 502);
  }
  inv.assertCurrent();
  const telegram = origin.kind === "telegram" ? null : pairedTelegram(w, agent.id);
  const action = w.store.reserve({
    assistantId: agent.id,
    conversationId: conversation.id,
    attemptId: inv.attemptId,
    origin,
    key,
    state: "awaiting_approval",
    payload: {
      action: "ssh_access",
      approval: true,
      ...fields,
      projectName,
      hostKey: scanned.hostKey,
      hostFingerprint: scanned.hostFingerprint,
    },
    ...(telegram ? { telegram } : {}),
  });
  audit(w, "ssh.proposed", action);
  notifyAction(w, action, "approval");
  w.a.changed?.({ feeds: false });
  return {
    status: "approval_requested",
    proposalId: action.id,
    hostFingerprint: scanned.hostFingerprint,
  };
}

/** A key the owner picked: one of the proposal's project (or of none). */
function pickedKey(management, keyId, projectId) {
  if (keyId === undefined || keyId === null) return null;
  textValue(keyId, 100);
  let key = null;
  try {
    key = management.store.keyStore.get(keyId);
  } catch {}
  if (!key || (key.projectId ?? null) !== (projectId ?? null))
    throw assistantProblem("sshProposalKey");
  return key.id;
}

/**
 * The owner's decision. Approving scans the host again, registers it pinned to the
 * proposed key (verified by the owner) with a managed or the picked key, and grants
 * it to the agent in `input.mode` (default `approval`). A changed host key, an
 * existing endpoint or an agent that can no longer hold SSH fail the proposal with
 * nothing written; an unreachable host or a bad pick leave it open.
 */
export async function decideSshProposal(w, action, decision, input = {}) {
  if (!["approve", "decline"].includes(decision)) throw assistantProblem("invalid");
  const deciding = (w.sshProposalDeciding ??= new Set());
  if (deciding.has(action.id)) throw assistantProblem("conflict", 409);
  deciding.add(action.id);
  try {
    return await decide(w, action, decision, input);
  } finally {
    deciding.delete(action.id);
  }
}

async function decide(w, action, decision, input) {
  const done = (state, extra = {}) => {
    const next = w.store.patch(action.id, { state, ...extra });
    w.a.changed({ feeds: false });
    return next;
  };
  const fail = (diagnostic) => {
    audit(w, "ssh.failed", action, { code: `SSH_${diagnostic}` });
    return done("failed", { diagnostic });
  };
  if (decision === "decline") {
    audit(w, "ssh.denied", action);
    return done("declined");
  }
  const management = w.s.sshManagement;
  if (!management) throw assistantProblem("unavailable", 503);
  const p = action.payload,
    mode = input.mode ?? "approval";
  if (!sshModes.includes(mode)) throw assistantProblem("invalid");
  const keyId = pickedKey(management, input.keyId, p.projectId);
  let agent = null;
  try {
    agent = w.a.store.getAssistant(action.assistantId);
  } catch {}
  const held = agent ? w.access.stored(agent.id).sshAccesses.length : 0;
  if (
    !agent ||
    !mayPropose(agent, !!w.s.assistantTelegramSenders?.connected(agent.id)) ||
    held >= maxGrants
  )
    return fail("AGENT_UNAVAILABLE");
  if (existingHost(management, p)) return fail("HOST_EXISTS");
  let scanned;
  try {
    scanned = await management.store.scan({ host: p.host, port: p.port });
  } catch {
    throw assistantProblem("sshProposalScanFailed", 502);
  }
  if (scanned.hostKey !== p.hostKey) return fail("HOST_KEY_CHANGED");
  const registered = await registerVerifiedHost(management, {
    name: p.name,
    host: p.host,
    port: p.port,
    username: p.username,
    hostKey: p.hostKey,
    projectId: p.projectId,
    ...(keyId ? { keyId } : {}),
  });
  const host = registered.host;
  try {
    w.access.grantSsh(agent.id, host.id, mode);
  } catch {
    // Nothing of the approval stays: the host, and the key made for it, go again.
    await removeVerifiedHost(management, registered).catch(() => {});
    return fail("AGENT_UNAVAILABLE");
  }
  audit(w, "ssh.accepted", action, { accessId: host.id, mode });
  // The first grant gives the agent agentpier_ssh; a failed apply converges later.
  if (!held && w.a.runtime?.client?.ready)
    Promise.resolve()
      .then(() => w.a.admit(() => w.a.config.apply(agent.id)))
      .catch(() => {});
  return done("completed", {
    result: {
      accessId: host.id,
      hostName: host.name,
      keyId: host.keyId,
      keyName: host.keyName,
      publicKey: host.publicKey,
      keyFingerprint: host.fingerprint,
      keyCreated: registered.keyCreated,
      mode,
    },
  });
}

/** The agent hears the outcome once in the chat it proposed in. */
async function followUp(w, a) {
  if (a.followUp) return true;
  if (archived(w, a.assistantId)) {
    w.store.patch(a.id, { followUp: { skipped: "ASSISTANT_ARCHIVED" } });
    return true;
  }
  return handOver(w, a, "followUp", {
    conversationId: a.conversationId,
    requestId: `ssh-access-followup:${a.id}`,
    text: followUpText(a),
    context: { kind: "ssh-access-result" },
  });
}

/** The workflows tick: expiry, the approval notice, then the outcome. */
export async function advanceSshProposal(w, a) {
  if (w.sshProposalDeciding?.has(a.id)) return;
  if (a.state === "awaiting_approval") {
    if (a.expiresAt >= Date.now()) return notifyAction(w, a, "approval");
    a = w.store.patch(a.id, { state: "expired" });
    audit(w, "ssh.expired", a);
  }
  if (!terminal.has(a.state)) return;
  notifyAction(w, a, "result");
  if (await followUp(w, a)) w.store.patch(a.id, { settled: true });
}
