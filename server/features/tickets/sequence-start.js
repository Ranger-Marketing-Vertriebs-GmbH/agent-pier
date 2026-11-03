// The start of a sequence item: a session in its own worktree with the sequence task,
// or a pipeline run queued under a reserved id; plus the restart path that adopts an
// interrupted start instead of launching a second one.
import { createHash, randomUUID } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { isCodingCli } from "../clis/catalog.js";
import { sessionScope } from "../chat/chat-delivery.js";
import { keyToken } from "./pr-status.js";
import { ticketRef } from "./ticket.js";
import { sequenceSessionTask, ticketTask } from "./ticket-task.js";
import { ticketsProjectChanged } from "./live-topics.js";
import { isTimedOut, isTransient } from "./sequence-reasons.js";

const copy = serverMessages.tickets;
const DELIVERING = new Set(["pending", "handed-off", "uncertain"]);
const REMOTE_PREFIX = "refs/remotes/origin/";

/** A UUID derived from `seed`, so a resumed delivery reuses the first one's id. */
export function stableUuid(seed) {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The worktree folder of an item: `ticket-<key>-<id8>`, only [a-z0-9-]; a later attempt
 * (Retry after a closed PR) adds `-a<n>`, so the earlier folder stays untouched.
 */
export function worktreeName(item) {
  const token = String(keyToken(item) || "ticket")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const id = String(item.id)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  const attempt =
    Number.isInteger(item.attempt) && item.attempt > 1 ? `-a${item.attempt}` : "";
  return `ticket-${token || "ticket"}-${id || "x"}${attempt}`;
}

function sessionName(ticket) {
  return `${ticket.key} · ${String(ticket.title ?? "").slice(0, 60)}`.slice(0, 100);
}

function validateAccount(account) {
  if (!isCodingCli(account.tool)) throw problem(copy.codingCliRequired);
}

// ── waiting ──────────────────────────────────────────────────────────────────

export async function startItem(engine, ctx, item) {
  if (!ctx.github) return engine.park(ctx, item, "githubRequired");
  if (!ctx.access || !ctx.source) return engine.park(ctx, item, "sourceUnavailable");
  const { ticket, stop } = await engine.readTicket(ctx, item);
  if (!ticket) return stop;
  let baseBranch = null;
  if (item.kind === "pipeline") {
    try {
      baseBranch =
        item.options.pipeline?.baseBranch ??
        (await engine.forge.defaultBranch(ctx.github, engine.signal()));
    } catch (error) {
      return engine.forgeFailed(ctx, item, error, "default-branch");
    }
  }
  if (engine.closed) return false;
  let saved = engine.save(ctx, item, {
    state: "running",
    starting: true,
    startedAt: engine.now(),
    watchSince: null,
    forgeFailingSince: null,
  });
  try {
    saved =
      item.kind === "session"
        ? await launchSession(engine, ctx, saved, ticket)
        : queueRun(engine, ctx, saved, ticket, baseBranch);
    if (!saved) return false;
    await recordStart(engine, ctx, saved, ticket);
    engine.save(ctx, saved, { starting: false });
  } catch (error) {
    engine.onError(error, "start");
    return engine.park(ctx, saved, isTimedOut(error) ? "stepTimedOut" : "startFailed");
  }
  return false;
}

async function launchSession(engine, ctx, item, ticket) {
  let saved = item;
  // Retry keeps the worktree of an earlier attempt only when it is clean and still on
  // its branch (sequence-service.js); a folder that is gone is created again.
  if (!(item.worktree?.cwd && (await engine.worktrees.exists(item.worktree.cwd)))) {
    const tree = await engine.worktrees.createSession({
      projectPath: ctx.project.path,
      ticket,
      name: worktreeName(item),
    });
    const baseRef = tree.baseRef.startsWith(REMOTE_PREFIX)
      ? tree.baseRef.slice(REMOTE_PREFIX.length)
      : tree.baseRef;
    saved = engine.save(ctx, item, {
      worktree: { cwd: tree.cwd, branch: tree.branch, baseRef },
    });
  }
  const session = await engine.launch(
    { ...item.options.session, cwd: saved.worktree.cwd, name: sessionName(ticket) },
    false,
    { ticket: ticketRef(ticket), validateAccount },
  );
  saved = engine.save(ctx, saved, { sessionId: session.id });
  if (!(await deliverTask(engine, ctx, saved, session, ticket))) return null;
  return saved;
}

/**
 * Sends the sequence task with an id derived from the item, so a resumed start never
 * delivers it twice. A session the task cannot reach is stopped and the item parked.
 */
async function deliverTask(engine, ctx, item, session, ticket) {
  const text = sequenceSessionTask(ticket, {
    branch: item.worktree.branch,
    baseBranch: item.worktree.baseRef,
  });
  let receipt;
  try {
    receipt = await engine.chatDelivery.send(session.id, {
      // A Retry that resumed the session sends the task anew (its own id); a restart
      // within one attempt repeats the same id, so the task arrives once per attempt.
      deliveryId: stableUuid(
        `ticket-seq-task:${item.id}${item.watchSince ? `:${item.watchSince}` : ""}`,
      ),
      deliveryScope: sessionScope(session),
      text,
      submit: true,
    });
  } catch (error) {
    // 409: this delivery id already carries a task (an earlier copy of the ticket).
    if (error?.status === 409) return true;
    engine.onError(error, "deliver");
    receipt = isTimedOut(error) ? { status: "timedOut" } : null;
  }
  if (DELIVERING.has(receipt?.status)) return true;
  await Promise.resolve()
    .then(() => engine.sessions?.stop?.(session.id))
    .catch(() => {});
  engine.park(
    ctx,
    item,
    receipt?.status === "timedOut" ? "stepTimedOut" : "taskNotDelivered",
  );
  return false;
}

function queueRun(engine, ctx, item, ticket, baseBranch) {
  const runId = item.runId ?? randomUUID();
  const saved = item.runId ? item : engine.save(ctx, item, { runId });
  const pipeline = item.options.pipeline ?? {};
  engine.runQueue.add(
    ctx.projectId,
    {
      pipelineId: pipeline.pipelineId,
      task: ticketTask(ticket, { kind: "pipeline" }),
      ...(baseBranch ? { baseBranch } : {}),
      ...(pipeline.tokenBudget ? { tokenBudget: pipeline.tokenBudget } : {}),
      externalRef: ticket.key,
    },
    { id: runId, source: { kind: "ticket-sequence", ticket: ticketRef(ticket) } },
  );
  return saved;
}

/** PR 1's start record (the Tickets list shows "Started") and the in-progress mark. */
async function recordStart(engine, ctx, item, ticket) {
  const records = engine.tickets.store;
  const targetId = item.sessionId ?? item.runId;
  if (records.findStart(ctx.projectId, ticket.source, ticket.key)?.targetId === targetId)
    return;
  const start = records.addStart({
    projectId: ctx.projectId,
    source: ticket.source,
    key: ticket.key,
    title: ticket.title,
    url: ticket.url,
    kind: item.kind,
    targetId,
    writeBack: { state: "pending" },
  });
  ticketsProjectChanged(engine.hub(), ctx.projectId);
  await engine.tickets.writeBack(start, {
    source: ctx.source,
    access: ctx.access,
    link: ctx.link,
    ticket,
  });
}

// ── an interrupted start (restart) ───────────────────────────────────────────

export async function resumeStart(engine, ctx, item) {
  if (!ctx.github) return engine.park(ctx, item, "githubRequired");
  if (!ctx.access || !ctx.source) return engine.park(ctx, item, "sourceUnavailable");
  if (item.kind === "pipeline") return resumeRun(engine, ctx, item);
  let session;
  try {
    session = await findSession(engine, item);
  } catch (error) {
    return engine.skip(error, "sessions");
  }
  // Without a session of this ticket in its worktree the start is unknown: the
  // owner decides; AgentPier never launches a second one by itself.
  if (!session)
    return engine.park(ctx, item, item.sessionId ? "sessionEnded" : "startInterrupted");
  let saved = item.sessionId ? item : engine.save(ctx, item, { sessionId: session.id });
  const { ticket, stop } = await engine.readTicket(ctx, saved);
  if (!ticket) return stop;
  try {
    if (!(await deliverTask(engine, ctx, saved, session, ticket))) return false;
    await recordStart(engine, ctx, saved, ticket);
    saved = engine.save(ctx, saved, { starting: false });
  } catch (error) {
    engine.onError(error, "start");
    return engine.park(ctx, saved, isTimedOut(error) ? "stepTimedOut" : "startFailed");
  }
  return true;
}

/** The item's session, or a session launched for it before its id was saved. */
export async function findSession(engine, item) {
  const list = await engine.sessions.list();
  if (item.sessionId) {
    const found = list.find((session) => session.id === item.sessionId);
    return found && found.status !== "stopped" ? found : null;
  }
  if (!item.worktree?.cwd) return null;
  return (
    list
      .filter(
        (session) =>
          session.ticket?.key === item.key &&
          session.cwd === item.worktree.cwd &&
          session.status !== "stopped",
      )
      .at(-1) ?? null
  );
}

async function resumeRun(engine, ctx, item) {
  if (!item.runId) return engine.park(ctx, item, "startInterrupted");
  const { ticket, stop } = await engine.readTicket(ctx, item);
  if (!ticket) return stop;
  try {
    // The reserved run id: queued once, the queue refuses or keeps the same item.
    const known = engine.runQueue.find(item.runId) || (await engine.readRun(item.runId));
    if (!known) {
      const baseBranch =
        item.options.pipeline?.baseBranch ??
        (await engine.forge.defaultBranch(ctx.github, engine.signal()));
      queueRun(engine, ctx, item, ticket, baseBranch);
    }
    await recordStart(engine, ctx, item, ticket);
    engine.save(ctx, item, { starting: false });
  } catch (error) {
    // Only a forge or server that may recover skips the pass; anything else is final.
    if (isTransient(error)) return engine.skip(error, "start");
    engine.onError(error, "start");
    return engine.park(ctx, item, "startFailed");
  }
  return true;
}
