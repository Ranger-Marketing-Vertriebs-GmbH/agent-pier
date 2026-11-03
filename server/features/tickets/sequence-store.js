import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { writePrivate, readJSON, problem } from "../../lib/storage.js";
import { TICKET_SOURCE_IDS } from "./ticket.js";

const copy = serverMessages.tickets;
export const SEQUENCE_STATES = [
  "waiting",
  "running",
  "awaiting-merge",
  "needs-owner",
  "done",
];
const NEXT_STATES = {
  waiting: ["running"],
  running: ["awaiting-merge", "needs-owner"],
  "awaiting-merge": ["done", "needs-owner", "running"],
  "needs-owner": ["running", "waiting", "done"],
  done: [],
};
const MAX_ACTIVE = 200;
const MAX_DONE = 50;
const MAX_OPTION_BYTES = 8192;

const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
const optText = (value, max) =>
  typeof value === "string" && value ? value.slice(0, max) : undefined;
const number = (value) => (Number.isFinite(value) ? value : undefined);
const isActive = (item) => item.state !== "done";
const same = (a, b) => a.source === b.source && a.key === b.key;

function origin(value) {
  if (value?.kind === "manual") return { kind: "manual" };
  if (
    value?.kind === "rule" &&
    typeof value.ruleId === "string" &&
    value.ruleId &&
    value.ruleId.length <= 200
  )
    return { kind: "rule", ruleId: value.ruleId };
  return null;
}
function options(value) {
  if (!plain(value) || typeof value.allowMerge !== "boolean") return null;
  const out = { allowMerge: value.allowMerge };
  for (const name of ["session", "pipeline", "repair"]) {
    if (value[name] === undefined) continue;
    if (!plain(value[name]) || JSON.stringify(value[name]).length > MAX_OPTION_BYTES)
      return null;
    out[name] = value[name];
  }
  return out;
}
function pr(value) {
  if (!plain(value) || !Number.isInteger(value.number)) return undefined;
  return {
    number: value.number,
    url: text(value.url, 2048),
    headRef: text(value.headRef, 300),
  };
}
function worktree(value) {
  if (!plain(value) || typeof value.cwd !== "string" || !value.cwd) return undefined;
  return {
    cwd: value.cwd,
    branch: text(value.branch, 300),
    baseRef: text(value.baseRef, 300),
  };
}

/** One saved item, or null when it is not a valid item. Unknown fields are dropped. */
function item(value) {
  if (!plain(value)) return null;
  if (typeof value.id !== "string" || !value.id || value.id.length > 100) return null;
  if (!TICKET_SOURCE_IDS.includes(value.source)) return null;
  if (typeof value.key !== "string" || !value.key || value.key.length > 300) return null;
  if (!["session", "pipeline"].includes(value.kind)) return null;
  if (!SEQUENCE_STATES.includes(value.state)) return null;
  const itemOrigin = origin(value.origin ?? { kind: "manual" });
  const itemOptions = options(value.options);
  if (!itemOrigin || !itemOptions) return null;
  const rounds = plain(value.rounds) ? value.rounds : {};
  const out = {
    id: value.id,
    source: value.source,
    key: value.key,
    title: text(value.title, 500),
    url: text(value.url, 2048),
    kind: value.kind,
    origin: itemOrigin,
    options: itemOptions,
    state: value.state,
    addedAt: number(value.addedAt) ?? 0,
    rounds: {
      failed: Number.isInteger(rounds.failed) && rounds.failed > 0 ? rounds.failed : 0,
      lastSha: optText(rounds.lastSha, 100) ?? null,
      lastReview: optText(rounds.lastReview, 100) ?? null,
    },
  };
  if (number(value.startedAt) !== undefined) out.startedAt = value.startedAt;
  const sessionId = optText(value.sessionId, 200);
  if (sessionId) out.sessionId = sessionId;
  const runId = optText(value.runId, 200);
  if (runId) out.runId = runId;
  const tree = worktree(value.worktree);
  if (tree) out.worktree = tree;
  if (value.starting === true) out.starting = true;
  const request = pr(value.pr);
  if (request) out.pr = request;
  if (plain(value.repair) && typeof value.repair.sessionId === "string")
    out.repair = {
      sessionId: value.repair.sessionId.slice(0, 200),
      cwd: text(value.repair.cwd, 4096),
      sha: text(value.repair.sha, 100),
    };
  if (value.armed === "auto" || value.armed === "queue") out.armed = value.armed;
  else if (value.armed === null) out.armed = null;
  // The head AgentPier armed last: it never arms the same head twice.
  const armedHead = optText(value.armedHead, 100);
  if (armedHead) out.armedHead = armedHead;
  else if (value.armedHead === null) out.armedHead = null;
  if (
    plain(value.refused) &&
    typeof value.refused.headSha === "string" &&
    ["arm", "merge"].includes(value.refused.what)
  )
    out.refused = {
      headSha: value.refused.headSha.slice(0, 100),
      what: value.refused.what,
      code: text(value.refused.code, 64),
    };
  else if (value.refused === null) out.refused = null;
  if (value.forgeFailingSince === null || number(value.forgeFailingSince) !== undefined)
    out.forgeFailingSince = value.forgeFailingSince;
  if (plain(value.needsOwner) && typeof value.needsOwner.reason === "string")
    out.needsOwner = {
      reason: value.needsOwner.reason.slice(0, 64),
      at: number(value.needsOwner.at) ?? 0,
    };
  if (number(value.doneAt) !== undefined) out.doneAt = value.doneAt;
  if (value.doneBy === "merge" || value.doneBy === "owner") out.doneBy = value.doneBy;
  if (
    plain(value.writeBack) &&
    ["pending", "done", "failed"].includes(value.writeBack.state)
  )
    out.writeBack = {
      state: value.writeBack.state,
      ...(optText(value.writeBack.code, 64) ? { code: value.writeBack.code } : {}),
    };
  return out;
}

/** Drops the oldest done items beyond the cap; active items keep their order. */
function pruned(items) {
  const done = items.filter((entry) => !isActive(entry));
  let extra = done.length - MAX_DONE;
  if (extra <= 0) return items;
  return items.filter((entry) => isActive(entry) || extra-- <= 0);
}

/**
 * The per-repo queues of ticket sequences, persisted in ticket-sequences.json. Items are
 * only appended at the end; a rule (PR 3) and the owner write to the same order.
 */
export class TicketSequenceStore {
  constructor({ dataDir, now = Date.now, log = () => {} }) {
    this.now = now;
    this.log = log;
    this.file = path.join(dataDir, "ticket-sequences.json");
    let saved;
    let damaged = false;
    try {
      saved = readJSON(this.file, {});
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      damaged = true;
    }
    // Valid JSON of the wrong shape is as unusable as broken JSON.
    if (!plain(saved) || (saved.queues !== undefined && !plain(saved.queues)))
      damaged = true;
    if (damaged) {
      // A damaged file starts empty; the unreadable copy is kept for the owner.
      fs.renameSync(this.file, `${this.file}.corrupt-${this.now()}`);
      saved = {};
    }
    this.byProject = new Map();
    let dropped = 0;
    const queues = plain(saved?.queues) ? saved.queues : {};
    for (const [projectId, queue] of Object.entries(queues)) {
      if (!plain(queue) || typeof queue.repoPath !== "string" || !queue.repoPath) {
        dropped += 1;
        continue;
      }
      const items = [];
      for (const entry of Array.isArray(queue.items) ? queue.items : []) {
        const checked = item(entry);
        // A "Done" write-back cut off by a restart never finishes on its own.
        if (checked?.state === "done" && checked.writeBack?.state === "pending")
          checked.writeBack = { state: "failed", code: "interrupted" };
        if (checked && !items.some((other) => other.id === checked.id))
          items.push(checked);
        else dropped += 1;
      }
      this.byProject.set(projectId, {
        projectId,
        repoPath: queue.repoPath,
        items: pruned(items),
      });
    }
    if (dropped) this.log(`ticket-sequences: dropped-invalid count=${dropped}`);
  }
  save() {
    const queues = {};
    for (const [projectId, queue] of this.byProject) queues[projectId] = queue;
    writePrivate(this.file, { version: 1, queues });
  }
  queue(projectId) {
    const queue = this.byProject.get(projectId);
    return queue ? structuredClone(queue) : null;
  }
  queues() {
    return structuredClone([...this.byProject.values()]);
  }
  /** Appends new items (waiting) behind the existing ones; all or nothing. */
  append(projectId, repoPath, items) {
    if (typeof projectId !== "string" || !projectId || typeof repoPath !== "string")
      throw problem(copy.invalidSequence);
    const existing = this.byProject.get(projectId);
    const current = existing?.items ?? [];
    const added = [];
    for (const entry of items) {
      const active = [...current, ...added].filter(isActive);
      if (active.some((other) => same(other, entry)))
        throw problem(copy.ticketQueued, 409);
      if (active.length >= MAX_ACTIVE) throw problem(copy.sequenceFull, 409);
      const checked = item({
        state: "waiting",
        origin: { kind: "manual" },
        ...entry,
        state: "waiting",
        id: randomUUID(),
        addedAt: this.now(),
        rounds: { failed: 0, lastSha: null, lastReview: null },
      });
      if (!checked) throw problem(copy.invalidSequence);
      added.push(checked);
    }
    const next = {
      projectId,
      repoPath: existing?.repoPath ?? repoPath,
      items: pruned([...current, ...added]),
    };
    this.byProject.set(projectId, next);
    try {
      this.save();
    } catch (error) {
      if (existing) this.byProject.set(projectId, existing);
      else this.byProject.delete(projectId);
      throw error;
    }
    return structuredClone(next);
  }
  patch(projectId, itemId, patch) {
    const queue = this.byProject.get(projectId);
    const index = queue?.items.findIndex((entry) => entry.id === itemId) ?? -1;
    if (index < 0) throw problem(copy.itemNotFound, 404);
    const before = queue.items;
    const current = before[index];
    const state = patch?.state ?? current.state;
    if (state !== current.state && !NEXT_STATES[current.state].includes(state))
      throw problem(copy.invalidSequence, 409);
    const checked = item({ ...current, ...patch, id: current.id });
    if (!checked) throw problem(copy.invalidSequence);
    queue.items = pruned(before.map((entry, i) => (i === index ? checked : entry)));
    try {
      this.save();
    } catch (error) {
      queue.items = before;
      throw error;
    }
    return structuredClone(checked);
  }
  remove(projectId, itemId) {
    const queue = this.byProject.get(projectId);
    const found = queue?.items.find((entry) => entry.id === itemId);
    if (!found) throw problem(copy.itemNotFound, 404);
    const before = queue.items;
    queue.items = before.filter((entry) => entry !== found);
    try {
      this.save();
    } catch (error) {
      queue.items = before;
      throw error;
    }
  }
  /** The first item that is not done; a needs-owner head blocks the whole queue. */
  head(projectId) {
    const found = this.byProject.get(projectId)?.items.find(isActive);
    return found ? structuredClone(found) : null;
  }
}
