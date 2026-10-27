import path from "node:path";
import { randomUUID } from "node:crypto";
import { serverMessages } from "../../../lib/i18n/de.js";
import { digest } from "../assistant-access.js";
import { assistantProblem } from "../assistant-validation.js";
import { notifyAction } from "../assistant-action-notifications.js";
import { toolError } from "../tool-errors.js";
import { git } from "../../pipelines/workspace-git.js";
import { sessionGrant, stillGranted } from "./session-control.js";
import {
  codingToolNames,
  codingTools,
  launchDefaults,
  launchModes,
  sessionOptions,
} from "./session-options.js";

// The launch options a start may give, in the order they are stored and hashed.
const optionKeys = [
  "tool",
  "accountId",
  "providerConnectionId",
  "providerModelId",
  "nativeModelId",
  "name",
  "launchMode",
  "worktree",
  "baseBranch",
  "secretIds",
  "sshAccessIds",
  "nonoProfile",
  "agentpierTools",
  "agentbus",
];
const invalid = () => assistantProblem("invalid");
// Launch modes in which the CLI runs commands without asking.
const unattendedModes = new Set(["bypass", "yolo"]);
const text = (value, max) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);

// The given options, checked against what `options` offers the agent, and what the
// owner's approval shows of them (launchSummary).
async function validOptions(w, ctx, input) {
  const options = {};
  for (const key of optionKeys) if (input[key] !== undefined) options[key] = input[key];
  const { tool } = options;
  if (!codingTools.includes(tool) || !text(input.projectId, 100)) throw invalid();
  if (input.requestId !== undefined && !text(input.requestId, 100)) throw invalid();
  for (const key of ["worktree", "agentpierTools", "agentbus"])
    if (options[key] !== undefined && typeof options[key] !== "boolean") throw invalid();
  for (const [key, max] of [
    ["name", 100],
    ["baseBranch", 300],
    ["nativeModelId", 256],
  ])
    if (options[key] !== undefined && !text(options[key], max)) throw invalid();
  if (options.baseBranch !== undefined && options.worktree === false) throw invalid();
  if (options.launchMode !== undefined && !launchModes[tool].includes(options.launchMode))
    throw invalid();
  const offered = await sessionOptions(w, ctx);
  if (
    options.accountId !== undefined &&
    !offered.accounts.some((a) => a.id === options.accountId && a.tool === tool)
  )
    throw invalid();
  const connection =
    options.providerConnectionId === undefined
      ? null
      : offered.connections.find((c) => c.id === options.providerConnectionId);
  if (options.providerConnectionId !== undefined && !connection?.tools.includes(tool))
    throw invalid();
  if (
    options.providerModelId !== undefined &&
    !connection?.models.includes(options.providerModelId)
  )
    throw invalid();
  if (connection && options.nativeModelId !== undefined) throw invalid();
  for (const [key, list] of [
    ["secretIds", offered.secrets],
    ["sshAccessIds", offered.sshAccesses],
  ])
    if (
      options[key] !== undefined &&
      (!Array.isArray(options[key]) ||
        options[key].length > 50 ||
        options[key].some((id) => !list.some((entry) => entry.id === id)))
    )
      throw invalid();
  if (
    options.nonoProfile !== undefined &&
    !offered.sandboxProfiles.includes(options.nonoProfile)
  )
    throw invalid();
  return { options, launch: launchSummary(options, offered, connection) };
}

/**
 * What the owner approves besides project and CLI: the launch mode (`unattended`
 * when the CLI runs without asking), the account or connection and model, how many
 * secrets and SSH accesses, the sandbox profile, and the AgentPier tools and AgentBus.
 * Names and counts only, never a secret.
 */
export function launchSummary(options, offered, connection) {
  const launchMode = options.launchMode ?? launchDefaults.launchMode[options.tool];
  return {
    launchMode,
    unattended: unattendedModes.has(launchMode),
    account:
      offered.accounts.find((a) => a.id === options.accountId)?.name ??
      options.accountId ??
      null,
    connection: connection?.name ?? null,
    model: options.providerModelId ?? options.nativeModelId ?? null,
    secrets: options.secretIds?.length ?? 0,
    sshAccesses: options.sshAccessIds?.length ?? 0,
    sandbox: options.nonoProfile ?? null,
    agentpierTools: options.agentpierTools ?? launchDefaults.agentpierTools,
    agentbus: options.agentbus ?? launchDefaults.agentbus,
  };
}

// What the session record keeps of the turn that started it.
function sessionOrigin(w, ctx) {
  if (ctx.wake) {
    const record = w.sessions.store.get(ctx.wake.sessionId);
    if (record) return structuredClone(record.origin);
  }
  return {
    class: ctx.sessionClass,
    ...(ctx.routine ? { bindingId: ctx.routine.bindingId } : {}),
    ...(ctx.hook ? { hookId: ctx.hook.hookId } : {}),
  };
}

/** The tool's answer for a start action, as stored. */
export function startResult(a) {
  const running = a.state === "running";
  return {
    actionId: a.id,
    state: a.state,
    ...(running
      ? {
          sessionId: a.sessionId,
          name: a.result?.name ?? null,
          tool: a.result?.tool ?? a.payload.options.tool,
          accountId: a.result?.accountId ?? null,
          cwd: a.result?.cwd ?? null,
        }
      : {}),
    worktree: a.worktree
      ? {
          path: a.worktree.cwd,
          branch: a.worktree.branch,
          baseBranch: a.worktree.baseBranch,
        }
      : null,
    github: { signedIn: a.result?.github?.signedIn === true },
    ...(a.diagnostic ? { diagnostic: a.diagnostic } : {}),
  };
}

/**
 * agentpier_coding_session `start`: a coding CLI session in the project folder or,
 * by default, a new worktree of it. One action per `requestId` (key
 * `session-start:<assistantId>:<requestId>`): a retry with the same options returns
 * that action's outcome, waiting for it while it still runs here, and never starts
 * a second session; other options conflict. Team turns and starts on a lead's share
 * wait for the owner; every other turn starts right away.
 */
export async function startSession(w, ctx, input) {
  const { options, launch } = await validOptions(w, ctx, input);
  const { inherited } = sessionGrant(w, ctx, input.projectId);
  const requestId = input.requestId ?? randomUUID();
  const payload = {
    action: "session_start",
    projectId: input.projectId,
    requestId,
    options,
  };
  const key = `session-start:${ctx.assistantId}:${requestId}`;
  const existing = w.store.byKey(key);
  if (existing) {
    if (digest(existing.payload) !== digest(payload))
      throw assistantProblem("conflict", 409);
    await w.sessions.starting.get(key)?.catch(() => {});
    return startResult(w.store.get(existing.id));
  }
  const project = w.s.memory.project(input.projectId);
  const task = ctx.leadRequest;
  const action = w.store.reserve({
    assistantId: ctx.assistantId,
    conversationId: ctx.conversationId,
    attemptId: ctx.attemptId ?? null,
    origin: ctx.origin,
    key,
    payload,
    state: ctx.sessionClass === "team" || inherited ? "awaiting_approval" : "approved",
    sessionId: randomUUID(),
    sessionOrigin: sessionOrigin(w, ctx),
    projectName: project.name,
    launch,
    ...(inherited ? { inherited } : {}),
    ...(ctx.telegram ? { telegram: ctx.telegram } : {}),
    ...(task
      ? {
          leadRequestId: task.id,
          leadAssistantId: task.leadId,
          memberName: w.a.store.getAssistant(ctx.assistantId).name,
        }
      : {}),
  });
  w.a.changed();
  if (action.state === "awaiting_approval") {
    notifyAction(w, action, "approval");
    return startResult(action);
  }
  return startResult(await runStart(w, action));
}

/**
 * Runs an approved start once in this process (`w.sessions.starting` holds it by
 * key): resolves to the settled action, rejects with the start's problem after
 * storing it as failed.
 */
export function runStart(w, a) {
  const starting = w.sessions.starting;
  if (starting.has(a.key)) return starting.get(a.key);
  const promise = execute(w, a).finally(() => starting.delete(a.key));
  starting.set(a.key, promise);
  return promise;
}

async function execute(w, a) {
  a = w.store.patch(a.id, { state: "executing" });
  const { projectId, options } = a.payload;
  try {
    const project = w.s.memory.project(projectId);
    let cwd = project.cwd;
    if (options.worktree !== false) {
      try {
        await git(project.cwd, ["rev-parse", "--show-toplevel"]);
      } catch {
        throw assistantProblem("noRepository", 409);
      }
      // Kept whatever happens after it; a worktree is never removed automatically.
      const workspace = await w.s.pipelineWorkspace.prepare({
        runId: `agent-${a.sessionId}`,
        cwd: project.cwd,
        ...(options.baseBranch ? { baseBranch: options.baseBranch } : {}),
      });
      a = w.store.patch(a.id, {
        worktree: {
          runId: workspace.runId,
          cwd: workspace.cwd,
          branch: workspace.branch,
          baseBranch: workspace.baseBranch,
        },
      });
      cwd = workspace.cwd;
    }
    const { worktree: _worktree, baseBranch: _base, ...given } = options;
    const body = {
      ...given,
      name:
        options.name ??
        `${codingToolNames[options.tool]} · ${path.basename(project.cwd)}`,
      cwd,
      launchMode: options.launchMode ?? launchDefaults.launchMode[options.tool],
      agentbus: options.agentbus ?? launchDefaults.agentbus,
      agentpierTools: options.agentpierTools ?? launchDefaults.agentpierTools,
    };
    const agent = w.a.store.getAssistant(a.assistantId);
    // Owned before it launches: a startup or trust prompt the CLI asks while it
    // starts is held for the agent like any later one (operations-events.js).
    insertRecord(w, a, { pending: true });
    let session;
    try {
      session = await w.s.launch(body, false, {
        id: a.sessionId,
        startedBy: { kind: "agent", assistantId: a.assistantId, name: agent.name },
      });
    } catch (error) {
      dropPending(w, a.sessionId);
      if (error?.message === serverMessages.sessions.sessionLimitReached)
        throw assistantProblem("sessionLimit", 409);
      throw error;
    }
    return await settleRunning(w, a, { ...session, name: session.name ?? body.name });
  } catch (error) {
    const failed = w.store.patch(a.id, {
      state: "failed",
      settled: true,
      diagnostic: toolError(error).code,
    });
    audit(w, failed, "failure");
    w.a.changed();
    throw error;
  }
}

// The session's ownership record (session-store.js), once.
function insertRecord(w, a, extra = {}) {
  const records = w.sessions.store;
  if (records.get(a.sessionId)) return;
  records.insert({
    sessionId: a.sessionId,
    assistantId: a.assistantId,
    conversationId: a.conversationId,
    projectId: a.payload.projectId,
    actionId: a.id,
    requestId: a.payload.requestId,
    origin: a.sessionOrigin,
    inherited: a.inherited ?? null,
    worktree: a.worktree ?? null,
    seen: { state: "idle", at: Date.now() },
    observed: null,
    lastSentAt: null,
    wakeSeq: 0,
    ended: false,
    createdAt: Date.now(),
    ...extra,
  });
}

// The record of a session that never launched.
function dropPending(w, sessionId) {
  try {
    if (w.sessions.store.get(sessionId)?.pending) w.sessions.store.delete(sessionId);
  } catch (error) {
    console.error("Dropping a pending session record failed:", error?.message);
  }
}

/** The started session's ownership record, audit and running action. */
async function settleRunning(w, a, session) {
  const records = w.sessions.store;
  insertRecord(w, a);
  if (records.get(a.sessionId).pending)
    records.patch(a.sessionId, {
      pending: undefined,
      seen: { state: "idle", at: Date.now() },
    });
  let signedIn = false;
  try {
    const status = await w.s.github?.status(a.sessionId);
    signedIn = status?.configured === true && status.hosts.some((h) => h.credentialId);
  } catch {
    // Unknown counts as not signed in.
  }
  const next = w.store.patch(a.id, {
    state: "running",
    settled: true,
    result: {
      name: session.name ?? null,
      tool: session.tool ?? a.payload.options.tool,
      accountId: session.accountId ?? null,
      cwd: session.cwd ?? null,
      github: { signedIn },
    },
  });
  audit(w, next, "success");
  w.a.changed();
  return next;
}

// Ids and enums only (audit-agent-session-details.js); never options or names.
function audit(w, a, outcome) {
  try {
    w.s.audit?.append({
      action: "session.started",
      resourceType: "session",
      source: "system",
      outcome,
      ...(outcome === "success" ? { sessionId: a.sessionId } : {}),
      projectId: a.payload.projectId,
      details: {
        tool: a.payload.options.tool,
        agentSession: {
          assistantId: a.assistantId,
          op: "start",
          requestId: a.payload.requestId,
          worktree: a.payload.options.worktree !== false,
        },
      },
    });
  } catch (error) {
    console.error("Agent session audit failed:", error?.message);
  }
}

/**
 * The action tick for a start (AssistantWorkflows.advanceAction): notifies and
 * expires one awaiting approval, runs an approved one while its grant holds, and
 * settles one left `executing` by a crash (the store reads it back as `unknown`):
 * running when its session exists, otherwise failed (START_INTERRUPTED).
 */
export async function advanceStart(w, a) {
  if (w.sessions.starting.has(a.key)) return;
  if (a.state === "awaiting_approval") {
    if (a.expiresAt < Date.now())
      w.store.patch(a.id, { state: "expired", settled: true });
    else notifyAction(w, a, "approval");
    return;
  }
  if (a.state === "approved") {
    const record = { ...a, projectId: a.payload.projectId, inherited: a.inherited };
    if (!stillGranted(w, record))
      w.store.patch(a.id, {
        state: "failed",
        settled: true,
        diagnostic: "GRANT_REVOKED",
      });
    else await runStart(w, a).catch(() => {});
    return;
  }
  if (["executing", "unknown"].includes(a.state)) {
    let session;
    try {
      session = await w.s.sessions.get(a.sessionId);
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
    if (session) await settleRunning(w, a, session);
    else {
      dropPending(w, a.sessionId);
      w.store.patch(a.id, {
        state: "failed",
        settled: true,
        diagnostic: "START_INTERRUPTED",
      });
    }
    return;
  }
  if (!a.settled) w.store.patch(a.id, { settled: true });
}
