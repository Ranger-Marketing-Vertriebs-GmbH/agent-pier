import { refusal } from "../devices/device-registry.js";
import { isUserAgent } from "../users/user-access.js";
import { directOwnerTurn, goalTurn } from "./goal-turns.js";
import { requestKind, requestTerminal, taskWritable } from "./lead-request-store.js";
import { isLeadRoutine } from "./lead-routines.js";
import { ownerChat } from "./owner-runs.js";

/*
 * Which runs of an agent get Android devices, decided by the owner (AGENTPIER-508).
 * It is the devices' own gate, built on the origin facts the other agent tools use
 * (owner-runs.js, goal-turns.js), and every agentpier_device call passes it, at its
 * start and again when its turn on the device comes (agent-devices.js):
 *
 * - Only the owner's own agents: never an archived agent, an agent of restricted
 *   users or an agent with its own Telegram bot for other people
 *   (DEVICE_AGENT_INELIGIBLE), and only in the owner's own chat with the agent.
 * - A turn uses the agent's devices only when its recorded origin is one the owner
 *   decided on (`deviceOriginKinds`, an allow-list): their own message, a goal
 *   continuation and what their own agents and coding sessions report into the
 *   chat. Every other turn gets no device at all (DEVICE_RUN_FORBIDDEN): a
 *   forwarded message, what a restricted user, a team member or a remote host
 *   sent, the outcome of a mail, an SSH access or a memory proposal, a memory
 *   step, a kind nobody decided on yet, and every run whose origin AgentPier does
 *   not know.
 * - Routines, hook runs and the runs of the owner's chat without a turn use the
 *   agent's devices too.
 * - Creating, resetting and deleting (`manage`) is for a turn the owner started
 *   with a message of their own (goal-turns.js directOwnerTurn): never a routine, a
 *   hook, a goal continuation, a follow-up or a run without a turn.
 * - A call belongs to the run it names, not to whatever turn its session has now
 *   (`ownRun`): one that names another turn's run gets no device, and one of a run
 *   AgentPier sent no turn for never manages.
 * - A member working on a task of its lead uses what the lead passed on with that
 *   task (member-device-passes.js) beside its own devices, and never manages. The
 *   task counts only while the run that started it could have used devices itself:
 *   a lead that worked on someone else's content hands no device on, and a member
 *   with devices of its own does not use them for such a task either.
 * - What a lead sets up on its member reaches a device only while the lead could be
 *   given devices itself (`workingLead`): its task, and its routine on the member
 *   (lead-routines.js) alike. A lead with a bot for other people, an archived one
 *   or one that is gone starts no run with a device.
 *
 * The facts come from AgentPier's own records, never from the model: the bridge's
 * ticket says whether the call belongs to a turn, a routine's or a hook's run or a
 * run of the owner's chat without a turn (team-bridge.js prepare), and a turn's
 * origin is the context AgentPier recorded when it accepted the turn.
 */
const forbidden = () => refusal("DEVICE_RUN_FORBIDDEN", 403);
const ineligible = () => refusal("DEVICE_AGENT_INELIGIBLE", 403);
const taskMember = (agent) => !!agent.teamMemberId && agent.lifetime !== "permanent";

/**
 * Whether `agent` can be given devices at all: an owner's own agent that is neither
 * archived nor being deleted, serves no restricted users and has no bot for other
 * people. `services` holds `assistantTelegramSenders` when such bots exist.
 */
export function deviceAgent(services, agent) {
  if (!agent || agent.archivedAt || agent.deletingAt || isUserAgent(agent)) return false;
  try {
    return !services?.assistantTelegramSenders?.connected(agent.id);
  } catch {
    return false;
  }
}

/**
 * The origin kinds whose turns use devices, each decided by the owner
 * (AGENTPIER-508); every other kind, a new one too, gets none until it is decided
 * and listed here (tests/integration/agent-device-origins.test.js pins the list
 * against the kinds the server records):
 *
 * - `owner`, `telegram`: the owner's own message, which also manages unless it is
 *   a goal continuation (goal-turns.js directOwnerTurn).
 * - `reminder`, `member-result`, `team-result`, `coding-result`, `session-talk`,
 *   `coding-session`, `member-long-chat`: what the owner's own agents and coding
 *   sessions report into their chat. Use only.
 * - `mail-result`, `ssh-access-result`, `memory-result`, `coding-start`:
 *   AgentPier's own notice of how something ended that waited for the owner (a
 *   status, ids, an error code; no content of other people). Use only, so that an
 *   agent keeps its device when its work goes on after the owner's approval.
 *
 * Not listed, so without a device: `memory-step`, everything foreign
 * (owner-runs.js foreignKinds), `unknown` and a turn without a record.
 */
export const deviceOriginKinds = Object.freeze([
  "owner",
  "telegram",
  "reminder",
  "member-result",
  "team-result",
  "coding-result",
  "session-talk",
  "coding-session",
  "member-long-chat",
  "mail-result",
  "ssh-access-result",
  "memory-result",
  "coding-start",
]);

const usingKinds = new Set(deviceOriginKinds);

/**
 * Whether a turn's recorded origin lets the turn use devices: one of
 * `deviceOriginKinds` that is not forwarded. A goal turn that hands a result over
 * (lead-request-delivery.js goalResult) is judged by that result as well. No record
 * is no permission.
 */
export function deviceOrigin(origin) {
  if (!origin || typeof origin !== "object" || origin.forwarded) return false;
  if (!usingKinds.has(origin.kind)) return false;
  const result = goalTurn(origin) ? origin.result : null;
  return !result || (usingKinds.has(result?.kind) && !result.forwarded);
}

/**
 * Whether the run that started a task could have used devices: a turn of such an
 * origin, or a routine's run, which records `{ kind: "routine" }` as the task's
 * origin (lead-request-store.js).
 */
export const taskOrigin = (origin) => origin?.kind === "routine" || deviceOrigin(origin);

/**
 * Whether task `request` has ended as far as devices go: in a final phase, or asked
 * to stop (by its lead, the owner or its deadline) while its member's turn still
 * runs.
 */
export const taskEnded = (request) =>
  requestTerminal.has(request.phase) || !!request.cancelRequested;

// A routine of the owner's own (never a lead's on its member) writes unless they
// switched "May write" off; a lead's routine as AgentPier decides for it.
function routineWritable(w, binding) {
  try {
    return w.a.routines?.writable?.(binding) ?? binding?.routineWrites !== false;
  } catch {
    return false;
  }
}

// The task a member's turn works on, when the run that started it could have used
// devices: `{ request, lead }`. Throws DEVICE_RUN_FORBIDDEN otherwise.
function memberTask(w, agent, origin) {
  const teams = w.a.teams?.store;
  const request =
    typeof origin.requestId === "string" ? teams?.find?.(origin.requestId) : null;
  if (
    !request ||
    request.kind !== requestKind ||
    request.memberAssistantId !== agent.id ||
    taskEnded(request) ||
    // A colleague's request is the colleague's content, not the lead's.
    request.fromMemberId ||
    !taskOrigin(request.origin)
  )
    throw forbidden();
  return { request, lead: workingLead(w, request.parentAssistantId) };
}

// The lead `id` behind a member's run (a task, a routine it set up on the member)
// while it could be given devices itself. Throws DEVICE_RUN_FORBIDDEN otherwise.
function workingLead(w, id) {
  let lead = null;
  try {
    lead = w.a.store.getAssistant(id);
  } catch {
    throw forbidden();
  }
  if (lead.teamMemberId || !deviceAgent(w.s, lead)) throw forbidden();
  return lead;
}

/**
 * The run behind a bridge call, as far as devices go:
 *
 *   { agent, kind, manage, writable, request, lead }
 *
 * `kind` is `owner-turn`, `turn`, `task`, `routine`, `hook` or `owner-run`;
 * `manage` says whether the run may create, reset and delete; `writable` whether a
 * file may be written into the agent's workspace for it; `request` and `lead` are a
 * member's task and its lead. Throws DEVICE_AGENT_INELIGIBLE or
 * DEVICE_RUN_FORBIDDEN (both 403).
 */
export function deviceRun(w, inv) {
  const store = w.a.store;
  let found;
  try {
    found = locate(w, inv, store);
  } catch (error) {
    // A record that cannot be read is an origin AgentPier does not know.
    throw /^DEVICE_/.test(error?.code || "") ? error : forbidden();
  }
  const { agent, conversation } = found;
  if (!deviceAgent(w.s, agent)) throw ineligible();
  if (!ownerChat(agent, conversation)) throw forbidden();
  return found;
}

// Whether the call is of the bound turn's own run. The bridge binds a call to the
// one live turn of its session (team-bridge.js prepare) whatever run the call names,
// so the run it names is compared here:
// - A turn's own calls name the attempt's id (the send's idempotency key) or the run
//   id the Gateway acknowledged the send with; both map to the attempt
//   (RequestLedger#attemptForRun). A call that names another attempt (a late call of
//   an earlier turn, which may have been someone else's content) is refused.
// - A run id that maps to no attempt is a run AgentPier sent no turn for: OpenClaw's
//   follow-up after a background command and a check-in run in the chat's own
//   session under run ids of their own (assistant-owner-run-contract.test.js), also
//   while a newer turn is bound. Such a call is served like a run without a turn:
//   it uses devices when the bound turn may, and never manages.
// - Hermes names no run (its plugin sends none): its calls count as the bound turn's.
function ownRun(w, inv, attempt) {
  if (!inv.runId) return true;
  const named = w.a.ledger.attemptForRun?.(inv.runId) ?? null;
  if (named && named.id !== attempt.id) throw forbidden();
  return !!named;
}

function locate(w, inv, store) {
  const chat = (conversation) => ({
    conversation,
    agent: store.getAssistant(conversation.assistantId),
  });
  if (inv.hook)
    // A hook's run writes only its own memory, never a file from a device.
    return {
      ...chat(inv.hook.conversation),
      kind: "hook",
      manage: false,
      writable: false,
    };
  if (inv.routine) {
    const { binding, conversation } = inv.routine;
    // A lead's routine on its member is the lead's doing, as its task is.
    if (isLeadRoutine(binding)) workingLead(w, binding.leadId);
    return {
      ...chat(conversation),
      kind: "routine",
      manage: false,
      writable: routineWritable(w, binding),
    };
  }
  if (!inv.attemptId) {
    if (!inv.ownerRun) throw forbidden();
    const conversation = store.getConversation(inv.ownerRun.conversationId);
    // What such a run works on is what the chat's latest turn left there: it gets a
    // device only when that turn could have used one (the bridge itself refuses
    // the run only after someone else's content, owner-runs.js ownerRun). A chat
    // without any turn holds nothing the owner did not write.
    const latest = w.a.ledger.latestRequest(conversation.id);
    if (latest && !deviceOrigin(w.a.teams?.store?.context?.(latest.id)))
      throw forbidden();
    return {
      ...chat(conversation),
      kind: "owner-run",
      manage: false,
      writable: true,
    };
  }
  const attempt = w.a.ledger.getAttempt(inv.attemptId);
  const own = ownRun(w, inv, attempt);
  const request = w.a.ledger.getRequest(attempt.requestId);
  const turn = chat(store.getConversation(request.conversationId));
  const origin = w.a.teams?.store?.context?.(request.id);
  if (origin?.kind === "lead-request") {
    const task = memberTask(w, turn.agent, origin);
    return {
      ...turn,
      kind: "task",
      manage: false,
      writable: taskWritable(task.request),
      ...task,
    };
  }
  // A temporary member works on its lead's tasks only.
  if (taskMember(turn.agent) || !deviceOrigin(origin)) throw forbidden();
  const manage = own && directOwnerTurn(origin);
  return { ...turn, kind: manage ? "owner-turn" : "turn", manage, writable: true };
}
