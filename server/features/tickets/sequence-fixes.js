// Fix attempts of an open pull request: a notice to the ticket's session (or to the
// repair session of a pipeline ticket) for each new failing head or review, a repair
// session on the PR branch for pipeline tickets, and the owner limits: three failed
// check rounds, or a red PR whose worker stayed quiet for 30 minutes.
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { isCodingCli } from "../clis/catalog.js";
import { sessionScope } from "../chat/chat-delivery.js";
import { confirmedDelivery, isHookBlock } from "../chat/chat-delivery-blocked.js";
import { keyToken } from "./pr-status.js";
import { ticketRef } from "./ticket.js";
import { checksNotice, repairTask, reviewNotice } from "./ticket-task.js";
import { isTimedOut, isTransient } from "./sequence-reasons.js";
import { stableUuid } from "./sequence-start.js";

export const IDLE_LIMIT_MS = 1_800_000;
export const MAX_FAILED_ROUNDS = 3;
export const FORGE_LIMIT_MS = 1_800_000;
// A running ticket session that has opened no pull request after this long parks.
export const NO_PR_LIMIT_MS = 6 * 3_600_000;

const copy = serverMessages.tickets;
// "accepted": the CLI took the task. "handed-off" stays success for CLIs without a
// native source. A hook block is "rejected", so it fails like any rejection.
const DELIVERING = new Set(["pending", "handed-off", "uncertain", "accepted"]);
const QUIET = new Set(["idle", "stopped"]);
const MISSING = Object.freeze({ exists: false, state: "unknown", since: null });

const live = (worker) => worker.exists && worker.state !== "stopped";

/**
 * What the PR's state asks for. Pure: a failing head counts one round once, a review
 * that requests changes on a head is answered once, and a red PR whose worker is idle,
 * stopped or gone parks after IDLE_LIMIT_MS from the later of its quiet start and the
 * last fix action.
 */
export function fixDecision({ item, verdict, worker = MISSING, now }) {
  const saved = item.rounds ?? {};
  const rounds = {
    failed: saved.failed ?? 0,
    lastSha: saved.lastSha ?? null,
    lastReview: saved.lastReview ?? null,
    lastActionAt: saved.lastActionAt ?? null,
  };
  if (verdict.status !== "open") return { action: "none", rounds };
  const sha = verdict.headSha || "";
  const checks = verdict.checks === "failed" && sha !== rounds.lastSha;
  const review = verdict.changesRequested && sha !== rounds.lastReview;
  if (checks || review) {
    const next = { ...rounds, lastActionAt: now };
    if (checks) Object.assign(next, { failed: rounds.failed + 1, lastSha: sha });
    if (review) next.lastReview = sha;
    const notice = { checks, review };
    if (next.failed >= MAX_FAILED_ROUNDS)
      return { action: "park", reason: "failedRounds", rounds: next };
    if (item.kind === "pipeline" && !live(worker))
      return { action: "repair", rounds: next, notice };
    return { action: "notify", rounds: next, notice };
  }
  const red = verdict.checks === "failed" || verdict.changesRequested;
  if (red && (!worker.exists || QUIET.has(worker.state))) {
    const since = Math.max(worker.since ?? 0, rounds.lastActionAt ?? 0);
    if (since > 0 && now - since >= IDLE_LIMIT_MS)
      return { action: "park", reason: "idle", rounds };
  }
  return { action: "none", rounds };
}

function within(cwd, root) {
  if (typeof cwd !== "string" || !cwd) return false;
  const relative = path.relative(root, path.resolve(cwd));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The repo's last-used coding session settings: the newest coding-CLI session whose
 * folder is the project or below it. Pipeline and login sessions do not count.
 */
export async function repairDefaults(sessions, projectPath) {
  const root = path.resolve(projectPath);
  const list = (await sessions.list()).filter(
    (session) =>
      isCodingCli(session.tool) &&
      !session.pipeline &&
      session.purpose !== "login" &&
      within(session.cwd, root),
  );
  const newest = list
    .map((session, index) => ({ session, index, at: Date.parse(session.createdAt) || 0 }))
    .sort((a, b) => b.at - a.at || b.index - a.index)[0]?.session;
  if (!newest) return null;
  const body = { tool: newest.tool };
  if (newest.access?.providerConnectionId) {
    body.providerConnectionId = newest.access.providerConnectionId;
    if (newest.access.providerModelId)
      body.providerModelId = newest.access.providerModelId;
  } else {
    if (newest.accountId) body.accountId = newest.accountId;
    if (newest.nativeModelId) body.nativeModelId = newest.nativeModelId;
  }
  if (newest.launchMode) body.launchMode = newest.launchMode;
  return body;
}

function validateAccount(account) {
  if (!isCodingCli(account.tool)) throw problem(copy.codingCliRequired);
}

/**
 * The session that fixes the PR: the ticket's own session, or the repair session of a
 * pipeline ticket (found by its folder when a restart cut off saving its id).
 */
export async function findWorker(engine, item) {
  const repair = item.kind === "pipeline";
  const id = repair ? item.repair?.sessionId : item.sessionId;
  if (!id && !(repair && item.repair?.cwd)) return MISSING;
  const list = await engine.sessions.list();
  const session = id
    ? list.find((entry) => entry.id === id)
    : list
        .filter(
          (entry) =>
            entry.ticket?.key === item.key &&
            entry.cwd === item.repair.cwd &&
            entry.status !== "stopped",
        )
        .at(-1);
  if (!session) return MISSING;
  const adopted = !id;
  if (session.status === "stopped")
    return { exists: true, state: "stopped", since: null, session, adopted };
  let state = "unknown";
  let since = null;
  try {
    const read = engine.activity ? await engine.activity.read(session) : null;
    if (read?.state) state = read.state;
    const at = Date.parse(read?.since ?? "");
    if (Number.isFinite(at)) since = at;
  } catch {
    // An unreadable screen is no evidence of idleness.
  }
  return { exists: true, state, since, session, adopted };
}

/**
 * Sends `text` with an id derived from `seed`; a resent copy is dropped as a duplicate.
 * A delivery that timed out is thrown, so the caller parks the ticket.
 */
async function deliver(engine, session, seed, text) {
  try {
    const receipt = await confirmedDelivery(
      engine.chatDelivery,
      session.id,
      await engine.chatDelivery.send(session.id, {
        text,
        submit: true,
        deliveryId: stableUuid(seed),
        deliveryScope: sessionScope(session),
      }),
    );
    if (DELIVERING.has(receipt?.status)) return true;
    engine.onError(
      Object.assign(new Error(), {
        code: isHookBlock(receipt) ? receipt.reason : "notDelivered",
      }),
      "fix-deliver",
    );
  } catch (error) {
    if (error?.status === 409) return true;
    if (isTimedOut(error)) throw error;
    engine.onError(error, "fix-deliver");
  }
  return false;
}

function noticeText(item, notice, verdict) {
  const prUrl = item.pr?.url ?? "";
  const lines = [];
  if (notice.checks) lines.push(checksNotice({ prUrl, failed: verdict.failed }));
  if (notice.review) lines.push(reviewNotice({ prUrl }));
  return lines.join("\n");
}

const idPart = (item) =>
  String(item.id)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
const MAX_REPAIR_FOLDERS = 50;

/**
 * The repair worktree folder: `repair-<key>-<sha7>-<id8>`, with `-<n>` before the id
 * from the second attempt on the same head; only [a-z0-9-].
 */
function repairName(item, sha, attempt = 1) {
  const token = String(keyToken(item) || "ticket")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const head = String(sha)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 7);
  const n = attempt > 1 ? `-${attempt}` : "";
  return `repair-${token || "ticket"}-${head || "head"}${n}-${idPart(item) || "x"}`;
}

/**
 * The folder for a repair: the earlier repair worktree when it is clean and holds no
 * commits outside the PR branch, else a new worktree in the first free folder.
 */
async function repairFolder(engine, ctx, item, sha) {
  const { worktrees } = engine;
  const projectPath = ctx.project.path;
  const headRef = item.pr.headRef;
  if (
    item.repair?.cwd &&
    (await worktrees.reuseRepair({
      projectPath,
      cwd: item.repair.cwd,
      headRef,
      branchPrefix: `ticket-repair/${idPart(item) || "x"}`,
    }))
  )
    return item.repair.cwd;
  for (let attempt = 1; attempt <= MAX_REPAIR_FOLDERS; attempt += 1) {
    const name = repairName(item, sha, attempt);
    if ((await worktrees.inspect({ projectPath, name })).exists) continue;
    const head = sha.slice(0, 7);
    const tree = await worktrees.createRepair({
      projectPath,
      headRef,
      name,
      suffix: attempt > 1 ? `${head}-${attempt}` : head,
    });
    return tree.cwd;
  }
  throw problem(serverMessages.pipelineWorkspaces.worktreeExists, 409);
}

/**
 * Carries out a decision. `notify` delivers the checks or review notice; `repair`
 * starts a repair session on the PR branch and hands it the repair task. The rounds are
 * saved last, so a restart repeats an interrupted action under the same delivery id.
 */
export async function applyFix(engine, ctx, item, decision, verdict, worker = MISSING) {
  if (decision.action === "park") {
    engine.park(
      ctx,
      engine.save(ctx, item, { rounds: decision.rounds }),
      decision.reason,
    );
    return { item, stop: true };
  }
  if (decision.action === "notify") {
    if (worker.adopted) return startRepair(engine, ctx, item, decision, verdict, worker);
    if (live(worker))
      try {
        await deliver(
          engine,
          worker.session,
          `ticket-seq-notice:${item.id}:${verdict.headSha}:${decision.notice.checks}:${decision.notice.review}`,
          noticeText(item, decision.notice, verdict),
        );
      } catch (error) {
        engine.onError(error, "fix-deliver");
        engine.park(ctx, item, "stepTimedOut");
        return { item, stop: true };
      }
    return { item: engine.save(ctx, item, { rounds: decision.rounds }) };
  }
  if (decision.action === "repair")
    return startRepair(engine, ctx, item, decision, verdict, worker);
  return { item };
}

// A PR branch the repair task may name in its push command: no shell metacharacters.
const SAFE_REF = /^[A-Za-z0-9._/-]{1,255}$/;

async function startRepair(engine, ctx, item, decision, verdict, worker) {
  const sha = verdict.headSha || "";
  if (!SAFE_REF.test(item.pr?.headRef ?? "")) {
    engine.park(ctx, engine.save(ctx, item, { rounds: decision.rounds }), "repairFailed");
    return { item, stop: true };
  }
  const { ticket } = await engine.readTicket(ctx, item);
  if (!ticket) return { item, stop: true };
  let saved = item;
  let session = worker.adopted ? worker.session : null;
  try {
    if (!session) {
      const body =
        item.options.repair ?? (await repairDefaults(engine.sessions, ctx.project.path));
      if (!body) {
        engine.park(
          ctx,
          engine.save(ctx, saved, { rounds: decision.rounds }),
          "repairUnconfigured",
        );
        return { item: saved, stop: true };
      }
      // An earlier repair worktree (also one a restart cut off before its launch) is
      // reused when it is clean; otherwise the repair gets a folder of its own.
      const cwd = await repairFolder(engine, ctx, saved, sha);
      saved = engine.save(ctx, saved, { repair: { sessionId: "", cwd, sha } });
      session = await engine.launch(
        { ...body, cwd, name: `${ticket.key} · repair`.slice(0, 100) },
        false,
        { ticket: ticketRef(ticket), validateAccount },
      );
    }
    const text = repairTask(ticket, {
      prUrl: saved.pr.url,
      headRef: saved.pr.headRef,
      failed: verdict.failed,
      changesRequested: verdict.changesRequested,
    });
    // The task goes out before the session id is saved: a restart in between adopts
    // the session by its folder and repeats the task under the same delivery id.
    await deliver(engine, session, `ticket-seq-repair:${saved.id}:${sha}`, text);
    saved = engine.save(ctx, saved, {
      repair: { sessionId: session.id, cwd: session.cwd ?? saved.repair?.cwd ?? "", sha },
      rounds: decision.rounds,
    });
  } catch (error) {
    // The PR branch could not be fetched: an outage the 30-minute forge clock bounds.
    if (error?.code === "repairFetchFailed") {
      engine.forgeFailed(ctx, saved, error, "repair");
      return { item: saved, stop: true };
    }
    if (isTransient(error)) {
      engine.skip(error, "repair");
      return { item: saved, stop: true };
    }
    engine.onError(error, "repair");
    // A repair session whose task never arrived is stopped, like a ticket's session.
    if (isTimedOut(error) && session)
      await Promise.resolve()
        .then(() => engine.sessions?.stop?.(session.id))
        .catch(() => {});
    engine.park(
      ctx,
      engine.save(ctx, saved, { rounds: decision.rounds }),
      isTimedOut(error) ? "stepTimedOut" : "repairFailed",
    );
    return { item: saved, stop: true };
  }
  return { item: saved };
}

/**
 * The fix step of an open PR, before any merge: reads the worker only when the PR is
 * red. Returns `{ item, stop }`: `item` is the saved item; `stop` ends the step (the
 * item parked, or this pass skips it).
 */
export async function fixStep(engine, ctx, item, verdict) {
  if (verdict.status !== "open") return { item };
  if (verdict.checks !== "failed" && !verdict.changesRequested) return { item };
  let worker;
  try {
    worker = await findWorker(engine, item);
  } catch (error) {
    engine.skip(error, "sessions");
    return { item, stop: true };
  }
  const decision = fixDecision({ item, verdict, worker, now: engine.now() });
  if (decision.action === "none") return { item };
  return applyFix(engine, ctx, item, decision, verdict, worker);
}
