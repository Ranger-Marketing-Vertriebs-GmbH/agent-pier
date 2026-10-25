import { assistantProblem, textValue } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";
import { directOwnerTurn } from "./goal-turns.js";
import { notifyAction } from "./assistant-action-notifications.js";
import { pairedTelegram } from "./team-coding.js";
import { actionPath, fenced } from "./action-text.js";

/**
 * The agent's own hook proposals (tool `agentpier_hook`, reached through the team
 * bridge). Only a turn of the owner's own message may propose or list hooks; a
 * proposal is an approval action (`hook_proposal`) in the chat, Telegram and the
 * Inbox, and the hook exists only once the owner approves it: created as the
 * agent's, without a secret (AgentHooks.create), which the owner creates in the
 * browser. The agent never sees a secret, and Telegram never shows one.
 */
const createKeys = ["name", "sender", "instruction", "rights", "hourlyLimit"];
const proposeKeys = ["action", "reason", ...createKeys];
const terminal = new Set(["completed", "failed", "declined", "expired"]);
const ownerOnly = () => assistantProblem("hookOwnerOnly", 403);
const instructionLimit = 1500;

/** The owner's own turn of an eligible agent behind a tool call; throws otherwise. */
function ownerTurn(hooks, inv) {
  // A routine's or a hook's own run and a command's completion have no turn.
  if (!inv.attemptId || inv.routine || inv.hook || inv.continuation) throw ownerOnly();
  const a = hooks.assistants,
    attempt = a.ledger.getAttempt(inv.attemptId),
    request = a.ledger.getRequest(attempt.requestId),
    conversation = a.store.getConversation(request.conversationId),
    agent = a.store.getAssistant(conversation.assistantId),
    origin = a.teams.store.context(request.id);
  // The owner's own message (web or Telegram), never a goal continuation, which
  // AgentPier sends on his behalf, nor forwarded content.
  if (!directOwnerTurn(origin)) throw ownerOnly();
  return { agent: hooks.eligible(agent.id), conversation, origin };
}

/** agentpier_hook: `list` the agent's hooks or `propose` one for the owner. */
export function invokeHook(hooks, inv, input) {
  inv.assertCurrent();
  if (!hooks) throw assistantProblem("unavailable", 503);
  const turn = ownerTurn(hooks, inv);
  if (input?.action === "list") {
    exact(input, ["action"]);
    // What each hook holds now and where it is reached; never a secret.
    return {
      hooks: hooks.list(turn.agent.id).hooks.map((hook) => ({
        id: hook.id,
        name: hook.name,
        sender: hook.sender,
        enabled: hook.enabled,
        active: hook.active,
        rights: hook.effective,
        addresses: hook.addresses,
      })),
    };
  }
  if (input?.action !== "propose") throw assistantProblem("invalid");
  exact(input, proposeKeys);
  const { action: _action, reason, ...fields } = input;
  const why = textValue(reason, 1000);
  // Checked as the owner's own create would be, against the live ceiling.
  const values = hooks.fields(fields, createKeys, turn.agent, true);
  const w = hooks.assistants.workflows;
  const { agent, conversation, origin } = turn;
  const telegram = origin.kind === "telegram" ? null : pairedTelegram(w, agent.id);
  const action = w.store.reserve({
    assistantId: agent.id,
    conversationId: conversation.id,
    attemptId: inv.attemptId,
    origin,
    key: `hook-proposal:${inv.attemptId}:${inv.toolCallId}`,
    state: "awaiting_approval",
    payload: {
      action: "hook_proposal",
      approval: true,
      name: values.name,
      sender: values.sender,
      reason: why,
      instruction: values.instruction,
      rights: values.rights,
      hourlyLimit: values.hourlyLimit,
    },
    ...(telegram ? { telegram } : {}),
  });
  notifyAction(w, action, "approval");
  hooks.assistants.changed?.({ feeds: false });
  return { status: "approval_requested", proposalId: action.id };
}

/**
 * The keys a decision may carry (AssistantWorkflows.decideOnce): the owner's
 * edited rights only from his browser, and only for a hook proposal.
 */
export function decisionKeys(w, id, input, origin) {
  const keys = ["revision", "decision"];
  if (origin?.kind !== "owner" || !input || typeof input !== "object") return keys;
  if (!("rights" in input)) return keys;
  try {
    return w.store.get(id).payload.action === "hook_proposal"
      ? [...keys, "rights"]
      : keys;
  } catch {
    return keys;
  }
}

/**
 * The owner's decision on a proposal. Approving re-checks the rights (his edit, or
 * the proposed ones) against what the agent holds now and creates the hook without
 * a secret; a right the agent lost, or hooks switched off, fail it closed.
 */
export function decideHookProposal(w, action, decision, input = {}) {
  if (!["approve", "decline"].includes(decision)) throw assistantProblem("invalid");
  const hooks = w.a.routines?.hooks;
  if (!hooks) throw assistantProblem("unavailable", 503);
  const done = (state, extra = {}) => {
    const next = w.store.patch(action.id, { state, ...extra });
    w.a.changed({ feeds: false });
    return next;
  };
  if (decision === "decline") return done("declined");
  const p = action.payload;
  let created;
  try {
    created = hooks.create(
      action.assistantId,
      {
        name: p.name,
        sender: p.sender,
        instruction: p.instruction,
        rights: "rights" in input ? input.rights : p.rights,
        hourlyLimit: p.hourlyLimit,
      },
      { actor: "assistant", proposalId: action.id },
    );
  } catch (error) {
    if (error?.key === "hookRightExceeds")
      return done("failed", { diagnostic: "RIGHTS_CHANGED" });
    if (error?.key === "hookUnavailable")
      return done("failed", { diagnostic: "HOOK_UNAVAILABLE" });
    // A malformed edit leaves the proposal open.
    throw error;
  }
  return done("completed", { result: { hookId: created.hook.id } });
}

/** The workflows tick: expiry, the approval notice, then the result notice. */
export function advanceHookProposal(w, a) {
  if (a.state === "awaiting_approval") {
    if (a.expiresAt >= Date.now()) return notifyAction(w, a, "approval");
    a = w.store.patch(a.id, { state: "expired" });
  }
  if (terminal.has(a.state)) {
    notifyAction(w, a, "result");
    w.store.patch(a.id, { settled: true });
  }
}

/** The ticked rights of a proposal, as the owner reads them in Telegram. */
export function rightLabels(rights, m) {
  const labels = m.hooks.rights;
  const ticks = ["notify", "telegram", "research", "coding", "memory", "mcp"];
  return [
    ...ticks.filter((key) => rights[key] === true).map((key) => labels[key]),
    ...(rights.shell && rights.shell !== "off"
      ? [labels.shell(m.memberGrants.levels[rights.shell] || rights.shell)]
      : []),
    ...(rights.sshHosts?.length ? [labels.ssh(rights.sshHosts.length)] : []),
    ...(Object.keys(rights.folders || {}).length
      ? [labels.folders(Object.keys(rights.folders).length)]
      : []),
  ];
}

// Cut by code point, so a surrogate pair is never split.
const cut = (text, limit) => {
  const points = Array.from(text);
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : text;
};

/**
 * The proposal in the owner's Telegram chat: hook, sender, reason, instruction and
 * ticked rights with approve and decline buttons, then its outcome. A created hook
 * has no secret yet; the notice says it is created in AgentPier in the browser.
 */
export function notifyHookProposal(w, action, phase, key, m, target) {
  if (!["approval", "result"].includes(phase)) return;
  const p = action.payload;
  let agent = "";
  try {
    agent = w.a.store.getAssistant(action.assistantId).name;
  } catch {}
  const labels = rightLabels(p.rights, m);
  const rights = labels.length
    ? m.hooks.proposalRights(labels.join(", "))
    : m.hooks.proposalNoRights;
  const text =
    phase === "approval"
      ? [
          m.hooks.proposalApproval(agent, p.name, p.sender),
          `${m.hooks.proposalReason}\n${fenced(p.reason)}`,
          ...(p.instruction
            ? [
                `${m.hooks.proposalInstruction}\n${fenced(cut(p.instruction, instructionLimit))}`,
              ]
            : []),
          rights,
          m.hooks.proposalWarning,
        ].join("\n\n")
      : [
          m.hooks.proposalStates[action.state] || m.actionStates.unknown,
          m.hooks.proposalName(p.name, p.sender),
          ...(action.state === "completed" ? [m.hooks.proposalSecret] : []),
        ].join("\n\n");
  const button = (decision, label) => ({
    proposalId: action.id,
    revision: action.revision,
    decision,
    label,
  });
  w.s.assistantChannels.outbox.enqueue({
    key,
    source: { ...target, actionId: action.id },
    kind: `action-${phase}`,
    localized: true,
    text,
    path: actionPath(action),
    actions:
      phase === "approval"
        ? [button("approve", m.hooks.proposalApprove), button("decline", m.actionDecline)]
        : [],
  });
}
