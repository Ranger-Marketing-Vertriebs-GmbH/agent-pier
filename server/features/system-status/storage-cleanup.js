import fs from "node:fs";
import { auditActor } from "../audit/audit-actor.js";
import { deleteSnapshot, listSnapshots } from "./cleanup-snapshots.js";
import {
  DEFAULT_CUTOFF_DAYS,
  deleteTranscripts,
  profileTranscripts,
  protectedIds,
} from "./cleanup-transcripts.js";
import {
  deleteDependencies,
  measureDependencies,
  sweepDependencies,
  workspaceIds,
} from "./cleanup-dependencies.js";
import { isUserAgent } from "../users/user-access.js";
import { processCwds } from "./workspace-processes.js";
import { cleanupProblem } from "./cleanup-problem.js";
import { BackgroundMeasure } from "./background-measure.js";

const TOOLS = ["claude", "codex"];
const safeId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id) ? id : undefined;
const busyTeam = ["completed", "failed", "cancelled"];
const busyAction = ["approved", "executing", "unknown", "running"];

/**
 * Whether an agent works now: a turn in flight, an active team task, a summary of a
 * long chat, or an approved action running. Any doubt counts as working.
 */
export function agentWorking(services, id) {
  const a = services.assistants;
  if (!a) return false;
  try {
    if (a.maintenance) return true;
    if (
      a.ledger
        ?.pending()
        .some(
          (attempt) =>
            a.store.getConversation(a.ledger.getRequest(attempt.requestId).conversationId)
              .assistantId === id,
        )
    )
      return true;
    if (
      services.assistantTeams?.store
        .members()
        .some((m) => m.assistantId === id && !busyTeam.includes(m.phase))
    )
      return true;
    if (a.longChats?.runningFor(new Set([id]))) return true;
    return !!a.workflows?.store.list(id).some((x) => busyAction.includes(x.state));
  } catch {
    return true;
  }
}

/**
 * Cleanup actions of System status › Storage: update backups, transcripts of ended
 * CLI sessions and the agents' installed dependencies. The lists are measured when
 * asked; their summary in the background and cached until a deletion. One deletion
 * runs at a time; every deletion is audited with what was removed and how much, never
 * a path, name or content.
 */
export class StorageCleanup {
  constructor({
    dataDir,
    services,
    audit,
    cwds = processCwds,
    now = Date.now,
    summaryMaxAgeMs = 10 * 60 * 1000,
    onError = () => {},
  }) {
    this.dataDir = fs.realpathSync(dataDir);
    Object.assign(this, { services, audit, cwds, now });
    this.running = null;
    this.summaryMeasure = new BackgroundMeasure({
      measure: (isClosed) => this.measureSummary(isClosed),
      maxAgeMs: summaryMaxAgeMs,
      now,
      onError,
    });
  }
  updates() {
    return this.services.assistantUpdates || null;
  }
  maintenance() {
    return !!this.services.assistants?.maintenance;
  }
  /** Startup: finishes node_modules deletions a restart interrupted. */
  start() {
    return sweepDependencies(this.dataDir).catch(() => {});
  }
  /**
   * Runs one deletion at a time. A refused or failed one is audited too, with its
   * area and the refusal's code, never its message or a path.
   */
  async exclusive({ area, resourceId, principal }, operation) {
    const failed = (error) => {
      const code = /^[A-Za-z]{1,40}$/.test(error?.code || "") ? error.code : "error";
      this.record(principal, resourceId, { area, code }, "failure");
      return error;
    };
    if (this.running) throw failed(cleanupProblem("busy", 409));
    this.running = operation();
    try {
      return await this.running;
    } catch (error) {
      throw failed(error);
    } finally {
      this.running = null;
      // Sizes are measured again on the next view, also after a partial failure.
      this.services.systemStatus?.staleAreas?.();
      this.summaryMeasure.invalidate();
    }
  }
  /** What each group can free, without opening its list (GET …/cleanup/summary). */
  summary() {
    return this.summaryMeasure.read();
  }
  /**
   * Sums the three lists: the update backups that may be deleted now (none while an
   * update runs, which `blocked` says; never the one a recovery needs), transcripts
   * older than the list's default age (90 days), and installed dependencies. Stops
   * early, with null, once `isClosed()` says AgentPier shuts down.
   */
  async measureSummary(isClosed = () => false) {
    const snapshots = await this.snapshots();
    if (isClosed()) return null;
    const backups = snapshots.snapshots.filter((item) => !item.reason);
    const days = DEFAULT_CUTOFF_DAYS;
    const transcripts = await this.transcripts(isClosed);
    if (isClosed()) return null;
    const profiles = transcripts.profiles.map(
      (profile) => profile.cutoffs.find((cutoff) => cutoff.days === days) || {},
    );
    const dependencies = await this.dependencies(isClosed);
    if (isClosed()) return null;
    const agents = dependencies.agents.filter((agent) => agent.folders);
    const sum = (items, key) =>
      items.reduce((total, item) => total + (item[key] || 0), 0);
    return {
      computedAt: new Date(this.now()).toISOString(),
      groups: {
        updateBackups: {
          bytes: sum(backups, "bytes"),
          count: backups.length,
          blocked: snapshots.blocked,
          atLeast: backups.some((item) => item.partial),
          oldestAt: backups.at(-1)?.createdAt ?? null,
        },
        transcripts: {
          bytes: sum(profiles, "bytes"),
          count: sum(profiles, "count"),
          olderThanDays: days,
          profiles: profiles.filter((cutoff) => cutoff.count > 0).length,
        },
        dependencies: {
          bytes: sum(agents, "bytes"),
          count: sum(agents, "folders"),
          agents: agents.length,
          atLeast: agents.some((agent) => agent.partial),
        },
      },
    };
  }
  close() {
    return this.summaryMeasure.close();
  }
  record(principal, resourceId, details, outcome = "success") {
    try {
      this.audit?.append({
        action: "storage.deleted",
        resourceType: "storage",
        resourceId,
        ...auditActor(principal),
        source: "user",
        outcome,
        details,
      });
    } catch {
      // The audit log never turns a finished cleanup into an error.
    }
  }
  async snapshots() {
    return listSnapshots({
      dataDir: this.dataDir,
      updates: this.updates(),
      maintenance: this.maintenance(),
    });
  }
  deleteSnapshot(id, principal) {
    const scope = { area: "update-backup", resourceId: safeId(id), principal };
    return this.exclusive(scope, async () => {
      const removed = await deleteSnapshot(
        {
          dataDir: this.dataDir,
          updates: this.updates(),
          maintenance: this.maintenance(),
        },
        id,
      );
      this.record(principal, id, {
        area: "update-backup",
        removed: 1,
        bytes: removed.bytes,
      });
      return { removed: 1, bytes: removed.bytes };
    });
  }
  profiles() {
    const accounts = this.services.accounts;
    return (accounts?.accounts || []).filter(
      (account) => account.kind === "managed" && TOOLS.includes(account.tool),
    );
  }
  profile(id) {
    const found = this.profiles().find((account) => account.id === id);
    if (!found) throw cleanupProblem("notFound", 404);
    return found;
  }
  // Pipeline runs resume CLI sessions by the ids their steps keep (run-store.js).
  async records() {
    const store = this.services.pipelines?.store;
    return store ? [JSON.stringify(store.all())] : [];
  }
  async transcripts(isClosed = () => false) {
    const profiles = [];
    for (const account of this.profiles()) {
      if (isClosed()) break;
      // Read again for each profile, so a long listing never counts on old records.
      const ids = await protectedIds(this.dataDir, () => this.records());
      const { cutoffs } = await profileTranscripts(
        this.dataDir,
        account,
        ids,
        this.now(),
      );
      profiles.push({
        id: account.id,
        name: typeof account.name === "string" ? account.name : "",
        tool: account.tool,
        cutoffs,
      });
    }
    return { profiles };
  }
  deleteTranscripts(id, days, principal) {
    const scope = { area: "transcripts", resourceId: safeId(id), principal };
    return this.exclusive(scope, async () => {
      const account = this.profile(id);
      const result = await deleteTranscripts(this.dataDir, account, days, {
        now: this.now(),
        records: () => this.records(),
      });
      this.record(principal, id, {
        area: "transcripts",
        tool: account.tool,
        olderThanDays: days,
        ...result,
      });
      return { ...result, databasesKept: account.tool === "codex" };
    });
  }
  /**
   * The owner's agent behind a workspace: its name, "" for a removed agent, or null
   * for an agent that serves restricted users (the owner never changes their agents'
   * content) or when that cannot be told (agents off or unreadable).
   */
  ownerAgent(id) {
    const store = this.services.assistants?.store;
    if (!store) return null;
    try {
      const agent = store.getAssistant(id);
      return isUserAgent(agent) ? null : { name: agent.name || "" };
    } catch (error) {
      return error?.status === 404 ? { name: "" } : null;
    }
  }
  async dependencies(isClosed = () => false) {
    const agents = [];
    for (const id of await workspaceIds(this.dataDir)) {
      if (isClosed()) break;
      const owner = this.ownerAgent(id);
      if (!owner) continue;
      const { folders, bytes, partial } = await measureDependencies(this.dataDir, id);
      agents.push({
        id,
        name: owner.name,
        folders: folders.length,
        bytes,
        partial,
        working: agentWorking(this.services, id),
      });
    }
    return { agents: agents.sort((a, b) => b.bytes - a.bytes) };
  }
  deleteDependencies(id, principal) {
    const scope = { area: "dependencies", resourceId: safeId(id), principal };
    return this.exclusive(scope, async () => {
      // A user's agent is not there for the owner, as with her chats.
      if (!this.ownerAgent(id)) throw cleanupProblem("notFound", 404);
      const result = await deleteDependencies(this.dataDir, id, {
        busy: async () => agentWorking(this.services, id),
        cwds: this.cwds,
      });
      this.record(principal, id, { area: "dependencies", ...result });
      return result;
    });
  }
}
