import { createHash } from "node:crypto";
import { serverMessages } from "../lib/i18n/de.js";
import { problem } from "../lib/storage.js";
import { identifier } from "../features/memory/memory-validation.js";
import { withDuplicates } from "../features/memory/project-duplicates.js";
import { sessionRecords } from "./project-cleanup.js";

const changed = () => problem(serverMessages.memory.duplicateChanged, 409);
const unsafe = () => problem(serverMessages.memory.duplicateMergeUnsafe, 409);

/**
 * Older project rows of a folder (a replaced folder, a Git identity that owned data
 * of its own, rows that both hold knowledge) stay untouched until the owner merges
 * one into the folder's current project. Nothing merges automatically; a merge the
 * owner started and that was interrupted resumes on the next start.
 */
export class ProjectDuplicates {
  constructor(services) {
    this.services = services;
  }
  /** The current row and the older row it lists, or a 409 when that changed. */
  async pair(currentId, olderId) {
    const described = await withDuplicates(this.services.memory.projects().projects);
    const current = described.find((row) => row.id === currentId);
    const older = described.find((row) => row.id === olderId);
    if (!older || !current?.olderDuplicates?.some((row) => row.id === olderId))
      throw changed();
    return { current, older };
  }
  /** What a merge of the project `olderId` moves; sessions is null when unknown. */
  counts(olderId) {
    const { memory, sshManagement, artifacts, pipelineDefinitions, config } =
      this.services;
    const catalog = sshManagement.catalog.read();
    const sessions = sessionRecords(config.dataDir);
    const entries = memory.entryCounts(olderId);
    return {
      entries: entries.active,
      archivedEntries: entries.archived,
      capabilities: memory.capabilityCount(olderId),
      sshAccess: [...catalog.keys, ...catalog.hosts].filter(
        (row) => row.projectId === olderId,
      ).length,
      artifacts: Object.values(artifacts.store.state.records).filter(
        (record) => record.projectId === olderId,
      ).length,
      verification: pipelineDefinitions.state.verification?.[olderId]?.length || 0,
      sessions: sessions
        ? sessions.filter(
            ({ data }) =>
              data?.memory?.projectId === olderId ||
              data?.sshTools?.project?.projectId === olderId,
          ).length
        : null,
    };
  }
  fingerprint(counts) {
    return createHash("sha256").update(JSON.stringify(counts)).digest("hex");
  }
  /** What a merge of `olderId` into `currentId` would move, with its fingerprint. */
  async preview(currentId, olderId) {
    identifier(currentId);
    identifier(olderId);
    await this.pair(currentId, olderId);
    const counts = this.counts(olderId);
    return { olderId, ...counts, fingerprint: this.fingerprint(counts) };
  }
  /** Refuses a move that would mix SSH access of two projects. */
  sshGuard(fromId, toId) {
    const { sshManagement } = this.services;
    if (sshManagement.ownsProject(fromId) && sshManagement.ownsProject(toId))
      throw unsafe();
  }
  /**
   * Merges `olderId` into `currentId` when nothing changed since the owner's preview
   * (`fingerprint`). Every check runs again inside the rebind queue, so concurrent
   * merges into one project see each other. Refuses a merge that would mix SSH
   * access of both projects or follow another recorded rebind.
   */
  async merge(currentId, { olderId, fingerprint } = {}) {
    const { memory, projectRebind } = this.services;
    identifier(currentId);
    identifier(olderId);
    if (memory.pendingMerge(olderId) === currentId) {
      await projectRebind.mergeDuplicate(olderId, memory.scopeOf(currentId), async () =>
        this.sshGuard(olderId, currentId),
      );
      return memory.project(currentId);
    }
    // Already merged and finished: change nothing.
    if (!memory.hasProject(olderId) && memory.reboundTo(olderId) === currentId)
      return memory.project(currentId);
    const check = async () => {
      await this.pair(currentId, olderId);
      if (
        typeof fingerprint !== "string" ||
        fingerprint !== this.fingerprint(this.counts(olderId))
      )
        throw changed();
      if (memory.reboundTo(olderId) || memory.reboundTo(currentId)) throw unsafe();
      this.sshGuard(olderId, currentId);
    };
    let merged;
    try {
      merged = await projectRebind.mergeDuplicate(
        olderId,
        memory.scopeOf(currentId),
        check,
      );
      if (!merged) throw unsafe();
    } catch (error) {
      if (error.status === 409) this.refused(currentId, olderId);
      throw error;
    }
    return memory.project(currentId);
  }
  refused(currentId, olderId) {
    this.services.audit.append({
      action: "project.updated",
      resourceType: "project",
      resourceId: currentId,
      projectId: currentId,
      source: "user",
      outcome: "failure",
      details: { fromProjectId: olderId },
    });
  }
  /** Finishes merges an earlier start left pending; a refused one stays pending. */
  async resume() {
    const { memory, projectRebind } = this.services;
    for (const { fromId, toId } of memory.pendingMerges()) {
      if (!memory.hasProject(toId)) continue;
      try {
        await projectRebind.mergeDuplicate(fromId, memory.scopeOf(toId), async () =>
          this.sshGuard(fromId, toId),
        );
      } catch (error) {
        console.error(
          `AgentPier could not finish a project merge; it retries next start: ${error?.code || error?.message || "unknown error"}`,
        );
      }
    }
  }
}
