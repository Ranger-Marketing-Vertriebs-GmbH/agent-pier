// The owner's side of ticket sequences: the queue view (REST and the tickets.queue
// topic), "start these tickets as a sequence", and the actions on a parked or waiting
// item. Retry, Mark done and Remove run inside the engine's lock of the queue, so they
// never interleave with a step; the engine steps the queue right after each of them.
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { TicketSourceError } from "./http-json.js";
import { prVerdict } from "./pr-status.js";
import { ticketQueueChanged } from "./live-topics.js";
import { TicketSequenceStore } from "./sequence-store.js";
import { TicketSequenceEngine, codeOf } from "./sequence-engine.js";
import { repairDefaults } from "./sequence-fixes.js";
import { worktreeName } from "./sequence-start.js";
import { canonicalKey, sequenceInput } from "./ticket-start-input.js";
import { TicketWorktrees } from "./ticket-worktree.js";

const copy = serverMessages.tickets;
const REPAIR_CACHE_MS = 60_000;
const FRESH_ROUNDS = { failed: 0, lastSha: null, lastReview: null, lastActionAt: null };
// What Retry clears on every path: the park, the fix counters and the merge memory.
const RESET = {
  needsOwner: null,
  rounds: FRESH_ROUNDS,
  forgeFailingSince: null,
  armed: null,
  armedHead: null,
  refused: null,
  starting: false,
};

/** An item as the browser sees it: no start options, folders or forge internals. */
export function publicItem(item) {
  const out = {
    id: item.id,
    source: item.source,
    key: item.key,
    title: item.title,
    url: item.url,
    kind: item.kind,
    origin: item.origin,
    state: item.state,
    addedAt: item.addedAt,
    options: {
      allowMerge: item.options.allowMerge,
      ...(item.options.pipeline?.pipelineId
        ? { pipelineId: item.options.pipeline.pipelineId }
        : {}),
    },
    rounds: { failed: item.rounds.failed },
  };
  for (const name of ["startedAt", "doneAt", "doneBy", "sessionId", "runId"])
    if (item[name] !== undefined) out[name] = item[name];
  if (item.worktree?.branch) out.branch = item.worktree.branch;
  if (item.pr) out.pr = { number: item.pr.number, url: item.pr.url };
  if (item.armed) out.armed = item.armed;
  if (item.repair?.sessionId) out.repair = { sessionId: item.repair.sessionId };
  if (item.needsOwner) out.needsOwner = { ...item.needsOwner };
  if (item.writeBack) out.writeBack = { ...item.writeBack };
  return out;
}

export class TicketSequenceService {
  constructor({ store, engine, tickets, sessions, worktrees, now = Date.now }) {
    Object.assign(this, { store, engine, tickets, sessions, worktrees, now });
    this.repairCache = new Map();
  }

  async view(projectId) {
    const project = this.tickets.resolveProject(projectId);
    const items = this.store.queue(project.id)?.items ?? [];
    const repair = await this.repairDefaults(project.path);
    return { queue: { items: items.map(publicItem) }, defaults: { repair } };
  }

  /**
   * The repair settings a new pipeline sequence would fall back to. Listing sessions
   * reads every stored session, and the topic reads the view after every saved change,
   * so the answer is kept for REPAIR_CACHE_MS per project folder.
   */
  async repairDefaults(projectPath) {
    const cached = this.repairCache.get(projectPath);
    if (cached && this.now() - cached.at < REPAIR_CACHE_MS) return cached.value;
    let value = null;
    try {
      value = await repairDefaults(this.sessions, projectPath);
    } catch {}
    this.repairCache.set(projectPath, { at: this.now(), value });
    return value;
  }

  async add(projectId, input) {
    const checked = sequenceInput(input);
    const project = this.tickets.resolveProject(projectId);
    const { link: _link, ...accesses } = await this.tickets.accesses(project);
    if (!accesses.github) throw problem(copy.githubRequired, 409);
    const wanted = checked.tickets.map(({ source, key }) => {
      const access = accesses[source];
      if (!access) throw new TicketSourceError("notConnected");
      return { source, key: canonicalKey(source, key, access), access };
    });
    if (
      !checked.again &&
      wanted.some(({ source, key }) =>
        this.tickets.store.findStart(project.id, source, key),
      )
    )
      throw problem(copy.alreadyStarted, 409);
    const entries = [];
    for (const { source, key, access } of wanted) {
      const ticket = await this.tickets.sources[source].get(access, key);
      entries.push({
        source,
        key: ticket.key,
        title: ticket.title,
        url: ticket.url,
        kind: checked.kind,
        origin: { kind: "manual" },
        options: {
          allowMerge: checked.allowMerge,
          ...(checked.session ? { session: checked.session } : {}),
          ...(checked.pipeline ? { pipeline: checked.pipeline } : {}),
          ...(checked.repair ? { repair: checked.repair } : {}),
        },
      });
    }
    this.store.append(project.id, project.path, entries);
    this.engine.nudge(project.id).catch((error) => this.engine.onError(error, "nudge"));
    return this.view(project.id);
  }

  /** A pipeline run changed (PipelineEngine onChange). */
  runChanged(run) {
    this.engine.runChanged(run);
  }

  /** Runs `action(project, item)` on one item inside the queue's lock. */
  async withItem(projectId, itemId, action) {
    const project = this.tickets.resolveProject(projectId);
    await this.engine.exclusive(project.id, async () => {
      const item = this.store
        .queue(project.id)
        ?.items.find((entry) => entry.id === itemId);
      if (!item) throw problem(copy.itemNotFound, 404);
      await action(project, item);
    });
    return this.view(project.id);
  }

  /**
   * A parked item tries again with fresh fix counters: an open (or merged) pull request
   * is watched again; otherwise the ticket starts afresh.
   */
  retry(projectId, itemId) {
    return this.withItem(projectId, itemId, async (project, item) => {
      if (item.state !== "needs-owner") throw problem(copy.itemBusy, 409);
      let next = item;
      if (item.pr) {
        const snapshot = await this.readPr(project, item);
        if (prVerdict(snapshot).status !== "closed") {
          this.store.patch(project.id, item.id, { ...RESET, state: "awaiting-merge" });
          return;
        }
        // A PR closed unmerged: the next attempt starts on a new branch from the
        // freshly fetched default branch, in a new folder; the old one stays.
        const { worktree: _old, ...rest } = item;
        next = { ...rest, attempt: (item.attempt ?? 1) + 1 };
      }
      const worktree =
        next.kind === "session" ? await this.leftover(project, next) : null;
      this.store.patch(project.id, item.id, {
        ...RESET,
        ...(next.attempt ? { attempt: next.attempt } : {}),
        state: "waiting",
        sessionId: null,
        runId: null,
        startedAt: null,
        pr: null,
        repair: null,
        worktree,
      });
    });
  }

  /**
   * The folder an earlier attempt left in `.worktrees/` (AgentPier never removes one):
   * kept for the new session when it is that attempt's clean worktree on its branch,
   * refused otherwise, so nothing the owner may still need is reused or overwritten.
   */
  async leftover(project, item) {
    const found = await this.worktrees.inspect({
      projectPath: this.store.queue(project.id)?.repoPath ?? project.path,
      name: worktreeName(item),
    });
    if (!found.exists) return null;
    if (
      found.worktree &&
      found.clean &&
      item.worktree?.cwd === found.cwd &&
      item.worktree.branch &&
      found.branch === item.worktree.branch
    )
      return item.worktree;
    throw problem(copy.worktreeLeftover, 409);
  }

  /**
   * The owner finished the ticket elsewhere: the queue moves on, the tracker stays. A
   * pull request AgentPier may have armed is disarmed first, since nobody watches it
   * afterwards (it must not merge past a later "changes requested").
   */
  markDone(projectId, itemId) {
    return this.withItem(projectId, itemId, async (project, item) => {
      if (item.state !== "needs-owner" && item.state !== "waiting")
        throw problem(copy.itemBusy, 409);
      if (this.mayBeArmed(item)) await this.disarm(project, item);
      this.store.patch(project.id, item.id, {
        state: "done",
        doneBy: "owner",
        doneAt: this.now(),
        starting: false,
      });
    });
  }

  /** Removes an item that is not being worked on; an armed pull request is disarmed. */
  remove(projectId, itemId) {
    return this.withItem(projectId, itemId, async (project, item) => {
      if (item.state === "running" || item.state === "awaiting-merge")
        throw problem(copy.itemBusy, 409);
      if (this.mayBeArmed(item)) await this.disarm(project, item);
      this.store.remove(project.id, item.id);
    });
  }

  /**
   * A parked item whose PR AgentPier may merge. The engine saves `armed`/`armedHead`
   * only after the arm call, so an unrecorded arm is possible and GitHub is read.
   */
  mayBeArmed(item) {
    return item.state === "needs-owner" && !!item.pr && item.options.allowMerge;
  }

  /** Turns GitHub's auto-merge off or takes the PR out of the merge queue. */
  async disarm(project, item) {
    const snapshot = await this.readPr(project, item);
    if (snapshot.state !== "OPEN") return;
    const { github } = await this.tickets.accesses(project);
    if (snapshot.inMergeQueue) await this.engine.forge.dequeue(github, snapshot);
    if (snapshot.autoMerge) await this.engine.forge.disableAutoMerge(github, snapshot);
  }

  async readPr(project, item) {
    const { github } = await this.tickets.accesses(project);
    if (!github) throw problem(copy.githubRequired, 409);
    try {
      return await this.engine.forge.readPullRequest(
        github,
        item.pr.number,
        this.engine.signal(),
      );
    } catch (error) {
      this.engine.onError(error, "owner-read-pr");
      throw error instanceof TicketSourceError
        ? error
        : new TicketSourceError(
            codeOf(error) === "notFound" ? "notFound" : "unavailable",
          );
    }
  }
}

/**
 * The sequence store, worktrees, engine and service of the application. The run queue,
 * pipelines and launch bind late: they exist only after createServices returns.
 */
export function createTicketSequenceServices(services, { tickets }) {
  const { config } = services;
  const ticketSequenceStore = new TicketSequenceStore({
    dataDir: config.dataDir,
    log: (line) => console.error(`AgentPier ${line}`),
    onChange: (projectId) => ticketQueueChanged(services.live, projectId),
  });
  const ticketWorktrees = new TicketWorktrees({
    dataDir: config.dataDir,
    github: services.github,
  });
  const sessions = {
    list: (...args) => services.sessions.list(...args),
    stop: (...args) => services.sessions.stop(...args),
  };
  const ticketSequenceEngine = new TicketSequenceEngine({
    store: ticketSequenceStore,
    tickets,
    worktrees: ticketWorktrees,
    launch: (...args) => services.launch(...args),
    chatDelivery: services.chatDelivery,
    sessions,
    activity: services.activity,
    runQueue: {
      add: (...args) => services.pipelineQueue.add(...args),
      find: (...args) => services.pipelineQueue.find(...args),
    },
    pipelines: { get: (...args) => services.pipelines.get(...args) },
    notifications: services.notifications,
    live: () => services.live,
    ...config.ticketSequences,
  });
  const ticketSequences = new TicketSequenceService({
    store: ticketSequenceStore,
    engine: ticketSequenceEngine,
    tickets,
    sessions,
    worktrees: ticketWorktrees,
  });
  return { ticketSequenceStore, ticketWorktrees, ticketSequenceEngine, ticketSequences };
}
