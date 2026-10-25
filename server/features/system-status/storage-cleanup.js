import fs from "node:fs";
import { auditActor } from "../audit/audit-actor.js";
import { deleteSnapshot, listSnapshots } from "./cleanup-snapshots.js";
import {
  deleteTranscripts,
  profileTranscripts,
  protectedIds,
} from "./cleanup-transcripts.js";
import {
  deleteDependencies,
  measureDependencies,
  workspaceIds,
} from "./cleanup-dependencies.js";
import { processCwds } from "./workspace-processes.js";
import { cleanupProblem } from "./cleanup-problem.js";

const TOOLS = ["claude", "codex"];
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
 * Cleanup actions of System status › Data directory: update backups, transcripts of
 * ended CLI sessions and the agents' installed dependencies. Sizes are measured only
 * when asked; one deletion runs at a time; every deletion is audited with what was
 * removed and how much, never a path, name or content.
 */
export class StorageCleanup {
  constructor({ dataDir, services, audit, cwds = processCwds, now = Date.now }) {
    this.dataDir = fs.realpathSync(dataDir);
    Object.assign(this, { services, audit, cwds, now });
    this.running = null;
  }
  updates() {
    return this.services.assistantUpdates || null;
  }
  maintenance() {
    return !!this.services.assistants?.maintenance;
  }
  async exclusive(operation) {
    if (this.running) throw cleanupProblem("busy", 409);
    this.running = operation();
    try {
      const result = await this.running;
      // The data directory sizes are measured again on the next view.
      this.services.systemStatus?.staleAreas?.();
      return result;
    } finally {
      this.running = null;
    }
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
    return this.exclusive(async () => {
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
  async transcripts() {
    const ids = await protectedIds(this.dataDir, () => this.records());
    const profiles = [];
    for (const account of this.profiles()) {
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
    return this.exclusive(async () => {
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
  agentName(id) {
    try {
      return this.services.assistants?.store.getAssistant?.(id)?.name || "";
    } catch {
      return "";
    }
  }
  async dependencies() {
    const agents = [];
    for (const id of await workspaceIds(this.dataDir)) {
      const { folders, bytes, partial } = await measureDependencies(this.dataDir, id);
      agents.push({
        id,
        name: this.agentName(id),
        folders: folders.length,
        bytes,
        partial,
        working: agentWorking(this.services, id),
      });
    }
    return { agents: agents.sort((a, b) => b.bytes - a.bytes) };
  }
  deleteDependencies(id, principal) {
    return this.exclusive(async () => {
      const result = await deleteDependencies(this.dataDir, id, {
        busy: async () => agentWorking(this.services, id),
        cwds: this.cwds,
      });
      this.record(principal, id, { area: "dependencies", ...result });
      return result;
    });
  }
}
