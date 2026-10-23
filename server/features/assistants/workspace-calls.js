import { approvalRevision, exact } from "./assistant-access.js";
import { notifyAction } from "./assistant-action-notifications.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { memberActions, memberContext, ownerTelegram } from "./team-coding.js";
import { fileActions } from "./agent-project-files.js";
import { withExcerpts } from "../memory/memory-search.js";
import { taskWritable } from "./lead-request-store.js";
import { workflowDefinitions } from "./team-plugin/workflow-tools.js";
import { resultTurn } from "./member-result-writes.js";
import { isUserAgent } from "../users/user-access.js";
import { directTurn } from "./memory-write-policy.js";
import { userAgentLocked } from "../users/user-agent-lock.js";

const workspaceKeys = Object.keys(workflowDefinitions.workspace.parameters.properties);
// What a task from the member's lead reaches (lead-shares.js): the folders and
// coding projects the lead shares with it, nothing of the member's own grants.
const leadTaskActions = new Set([
  "catalog",
  "actions",
  "coding_start",
  "coding_status",
  "coding_artifacts",
]);
// What a routine run reaches: what an owner turn does, apart from cancelling a run.
const routineRefused = new Set(["coding_cancel"]);

/**
 * The turn context of a workspace call: the owner's own turn (also from its
 * Telegram chat, not forwarded), a restricted user's own turn on her agent, a temporary member's team turn (team-coding.js)
 * a task the member's lead delegated to it (leadRequestContext) or a lead's follow-up
 * on its member's result (`memberResult`: the lead's own folders and projects, never
 * shares, and coding requests always wait for the owner) or the completion run of a
 * command such a direct turn started (`execContinuation`, exec-continuation.js: its
 * project folders only). Every other turn is refused.
 */
export function workspaceContext(w, inv) {
  inv.assertCurrent();
  if (!inv.attemptId && inv.routine) return routineContext(w, inv);
  if (!inv.attemptId && inv.continuation) return continuationContext(w, inv);
  const attempt = w.a.ledger.getAttempt(inv.attemptId);
  if (!["pending", "accepted", "running"].includes(attempt.state) || attempt.reviewedAt)
    throw assistantProblem("invalid", 403);
  const req = w.a.ledger.getRequest(attempt.requestId),
    chat = w.a.store.getConversation(req.conversationId);
  const origin = w.a.teams.store.context(req.id);
  if (origin.kind === "team-member") return memberContext(w, chat, attempt, origin);
  if (origin.kind === "lead-request")
    return leadRequestContext(w, chat, attempt, req, origin);
  const agent = w.access.eligible(chat.assistantId);
  // A lead's follow-up on its member's result acts like the lead's own work
  // (member-result-writes.js), on the lead's own access only.
  const memberResult =
    origin.kind === "member-result"
      ? resultTurn(w.a, origin.requestId, attempt.id)
      : null;
  // A restricted user's own turn counts only on an agent she is a user of.
  if (!memberResult && !directTurn(origin, agent)) throw assistantProblem("invalid", 403);
  return {
    assistantId: chat.assistantId,
    conversationId: chat.id,
    attemptId: attempt.id,
    origin,
    ...(memberResult ? { memberResult: { requestId: memberResult.id } } : {}),
  };
}

/**
 * A command's completion run (TeamBridge.prepare, re-proven on every step): the
 * direct turn that started it, re-checked live like that turn's own calls.
 */
function continuationContext(w, inv) {
  const attempt = w.a.ledger.getAttempt(inv.continuation.attemptId);
  const req = w.a.ledger.getRequest(attempt.requestId),
    chat = w.a.store.getConversation(req.conversationId);
  const origin = w.a.teams.store.context(req.id);
  if (!directTurn(origin, w.access.eligible(chat.assistantId)))
    throw assistantProblem("invalid", 403);
  return {
    assistantId: chat.assistantId,
    conversationId: chat.id,
    attemptId: attempt.id,
    origin,
    execContinuation: { attemptId: attempt.id },
  };
}

/**
 * A routine's own run (TeamBridge.routineRun: a bound, enabled routine of a
 * personal agent with routines on, re-checked on every step): the agent's own
 * project folders and its lead's standing shares, read always, changed only when
 * the owner marked the routine "May write" (`routineWrites` on its binding, read
 * live here). Coding requests always wait for the owner.
 */
function routineContext(w, inv) {
  const agent = w.access.eligible(inv.routine.conversation.assistantId);
  const run = w.a.routines?.runOrigin(agent, inv.sessionKey);
  if (!run || run.binding.id !== inv.routine.binding.id)
    throw assistantProblem("invalid", 403);
  const { binding, conversation } = run;
  return {
    assistantId: agent.id,
    conversationId: conversation.id,
    attemptId: null,
    origin: { kind: "routine", bindingId: binding.id },
    routine: {
      bindingId: binding.id,
      name: binding.definition?.name || "",
      // The owner's "May write", or for a lead's routine its autonomous usage.
      writable: w.a.routines?.writable?.(binding) ?? binding.routineWrites === true,
      key: `routine:${inv.sessionKey}`,
    },
  };
}

/**
 * A permanent member's turn for a task of its lead, while that task runs in exactly
 * this turn: `leadRequest` carries the task and whether it may change files
 * (taskWritable: the owner's request, an autonomous lead or a routine the owner
 * marked "May write").
 */
function leadRequestContext(w, chat, attempt, req, origin) {
  const r = w.a.teams?.store?.find(origin.requestId);
  if (
    !r ||
    r.kind !== "lead-request" ||
    r.memberAssistantId !== chat.assistantId ||
    req.clientRequestId !== `lead-request:${r.id}` ||
    !["dispatching", "running", "uncertain"].includes(r.phase) ||
    r.cancelRequested
  )
    throw assistantProblem("invalid", 403);
  const lead = w.a.store.getAssistant(r.parentAssistantId);
  if (lead.archivedAt) throw assistantProblem("invalid", 403);
  w.access.eligible(chat.assistantId);
  const telegram = ownerTelegram(r.origin);
  return {
    assistantId: chat.assistantId,
    conversationId: chat.id,
    attemptId: attempt.id,
    origin,
    leadRequest: {
      id: r.id,
      leadId: r.parentAssistantId,
      writable: taskWritable(r),
      // A sibling's request: never a share for a task. One the lead started (its
      // request, assignment or routine; peerLeadScope) reaches only the lead's
      // standing shares, as the lead's own would, for reads and writes.
      ...(r.fromMemberId
        ? {
            peer: true,
            sharesOnly: r.leadScope === true || r.peerWrites?.kind === "lead-task",
          }
        : {}),
    },
    ...(telegram ? { telegram } : {}),
  };
}

// A task of the lead (and a sibling's request it started) uses only what the lead
// shares; a lead task's own share counts in that task alone.
const leadTask = (ctx) =>
  !!ctx.leadRequest && (!ctx.leadRequest.peer || ctx.leadRequest.sharesOnly);
const shareScope = (ctx) => ({
  requestId: ctx.leadRequest && !ctx.leadRequest.peer ? ctx.leadRequest.id : null,
});

/**
 * The project a call works on, under the agent's own grant or, failing that, a
 * standing share of its lead (lead-shares.js): `{ policy, inherited }`. A task of
 * the lead uses only the lead's shares.
 */
function authorizeCall(w, ctx, projectId, pipelineId) {
  const scope = shareScope(ctx);
  const viaShare = () => {
    const share = w.shares.coding(ctx.assistantId, projectId, scope);
    if (!share) throw assistantProblem("invalid", 403);
    const inherited = {
      leadId: share.leadId,
      requestId: share.requestId || null,
      shareId: share.shareId,
    };
    return {
      policy: w.shares.authorize(
        ctx.assistantId,
        projectId,
        pipelineId,
        undefined,
        inherited,
      ),
      inherited,
    };
  };
  if (leadTask(ctx)) return viaShare();
  try {
    return { policy: w.access.authorize(ctx.assistantId, projectId, pipelineId) };
  } catch (error) {
    // A follow-up on a member's result uses the lead's own grants only.
    if (ctx.requestedBy || ctx.memberResult || error.status !== 403) throw error;
    try {
      return viaShare();
    } catch {
      throw error;
    }
  }
}

/** The catalog: own projects and pipelines, and what the lead shares (`sharedBy`). */
function catalog(w, ctx) {
  const scope = shareScope(ctx);
  const own = leadTask(ctx)
    ? { projectIds: [], pipelineIds: [], projectFiles: {} }
    : w.access.get(ctx.assistantId);
  const shared = w.shares.codingProjects(ctx.assistantId, scope);
  const levels = w.folders.levels(ctx);
  const all = w.access.catalog();
  const folders = new Map(w.folders.describe(levels).map((f) => [f.projectId, f]));
  const leads = new Map(shared.map((s) => [s.projectId, s.leadId]));
  const pipelineIds = new Set(own.pipelineIds);
  for (const leadId of new Set(leads.values()))
    for (const id of w.access.get(leadId).pipelineIds) pipelineIds.add(id);
  const ids = new Set([...own.projectIds, ...leads.keys(), ...folders.keys()]);
  return {
    // A granted folder names its path and level (agent-project-files.js).
    projects: all.projects
      .filter((x) => ids.has(x.id))
      .map(({ id, name }) => {
        const folder = folders.get(id);
        return {
          id,
          name,
          ...(folder ? { folder: { path: folder.path, access: folder.access } } : {}),
          ...(!own.projectIds.includes(id) && leads.has(id)
            ? { sharedBy: leads.get(id) }
            : {}),
        };
      }),
    pipelines: all.pipelines.filter((x) => pipelineIds.has(x.id)),
  };
}

/** One agentpier_workspace call (AssistantWorkflows.invoke, under admission). */
export async function workspaceCall(w, inv, input) {
  const ctx = workspaceContext(w, inv);
  exact(input, workspaceKeys);
  // A command's completion reaches the project folders only, never coding requests
  // or project memory (exec-continuation.js).
  if (
    ctx.execContinuation &&
    !fileActions.has(input.action) &&
    input.action !== "catalog"
  )
    throw assistantProblem("invalid", 403);
  // Project folders are the member's own grant (agent-project-files.js).
  if (fileActions.has(input.action)) return w.folders.invoke(ctx, input);
  // A user agent reaches only its folders: no coding, no project memory.
  if (input.action !== "catalog" && isUserAgent(w.a.store.getAssistant(ctx.assistantId)))
    throw userAgentLocked();
  if (ctx.requestedBy && !memberActions.has(input.action))
    throw assistantProblem("invalid", 403);
  if (ctx.leadRequest && !leadTaskActions.has(input.action))
    throw assistantProblem("invalid", 403);
  if (ctx.routine && routineRefused.has(input.action))
    throw assistantProblem("invalid", 403);
  if (input.action === "catalog") return catalog(w, ctx);
  if (["coding_status", "coding_cancel", "coding_artifacts"].includes(input.action))
    return w.coding.call(
      ctx.assistantId,
      input.id,
      {
        coding_status: "run_get",
        coding_cancel: "run_cancel",
        coding_artifacts: "run_artifacts",
      }[input.action],
      input.nodeId ? { nodeId: input.nodeId } : {},
      ctx.requestedBy,
    );
  if (input.action === "actions") return w.list(ctx.assistantId);
  const { policy: p, inherited } = authorizeCall(
    w,
    ctx,
    input.projectId,
    input.pipelineId,
  );
  if (input.action === "memory_search") {
    return withExcerpts(
      w.s.memory.list(input.projectId, {
        query: input.query || "",
        page: input.page || 1,
      }),
    );
  }
  if (input.action === "memory_read") return w.s.memory.read(input.projectId, input.id);
  if (!["memory_write", "coding_start"].includes(input.action))
    throw assistantProblem("invalid");
  const payload =
    input.action === "coding_start"
      ? {
          action: input.action,
          projectId: input.projectId,
          pipelineId: textValue(input.pipelineId, 100),
          task: textValue(input.task, 65536),
          ...(input.baseBranch ? { baseBranch: textValue(input.baseBranch, 300) } : {}),
        }
      : {
          action: input.action,
          projectId: input.projectId,
          title: textValue(input.title, 200),
          content: textValue(input.content, 32768),
          ...(input.id ? { id: input.id, expectedRevision: input.expectedRevision } : {}),
        };
  // A lead's share covers coding requests, never the project's memory.
  if (input.action === "memory_write" && (!p.memoryWrite || inherited))
    throw assistantProblem("invalid", 403);
  if (
    payload.id &&
    (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 1)
  )
    throw assistantProblem("invalid");
  inv.assertCurrent();
  const { leadRequest: task, routine, memberResult, ...stored } = ctx;
  const action = w.store.reserve({
    ...stored,
    payload,
    accessRevision: approvalRevision(p),
    key: `${routine?.key || inv.attemptId}:${inv.toolCallId}`,
    // A member's request, and every request on a lead's share, waits for the owner,
    // whatever the standing permission says.
    state:
      input.action === "coding_start" &&
      p.autonomous &&
      !ctx.requestedBy &&
      !inherited &&
      !routine &&
      !task?.peer &&
      !ctx.memberResult
        ? "approved"
        : "awaiting_approval",
    ...(inherited ? { inherited } : {}),
    ...(routine ? { routineId: routine.bindingId } : {}),
    // Requested in a follow-up on a member's result: always the owner's approval.
    ...(memberResult ? { via: "member-result", resultOf: memberResult.requestId } : {}),
    // A task's request waits in the lead's chat too (assistant-action-store.js delegated).
    ...(task
      ? {
          leadRequestId: task.id,
          leadAssistantId: task.leadId,
          memberName: w.a.store.getAssistant(ctx.assistantId).name,
        }
      : {}),
    projectName: w.s.memory.project(input.projectId).name,
    ...(input.pipelineId
      ? { pipelineName: w.s.pipelineDefinitions.getPipeline(input.pipelineId).name }
      : {}),
  });
  if (action.state === "awaiting_approval") notifyAction(w, action, "approval");
  w.a.changed();
  return w.project(action);
}
