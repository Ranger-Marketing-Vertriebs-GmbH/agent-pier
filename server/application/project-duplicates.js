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
 * one into the folder's current project. Nothing merges automatically.
 */
export class ProjectDuplicates {
  constructor(services) {
    this.services = services;
  }
  /** The current row and the older row it lists, or a 409 when that changed. */
  async pair(currentId, olderId) {
    identifier(currentId);
    identifier(olderId);
    const described = await withDuplicates(this.services.memory.projects().projects);
    const current = described.find((row) => row.id === currentId);
    const older = described.find((row) => row.id === olderId);
    if (!older || !current?.olderDuplicates?.some((row) => row.id === olderId))
      throw changed();
    return { current, older };
  }
  /** What a merge of `olderId` into `currentId` would move. */
  async preview(currentId, olderId) {
    const { older } = await this.pair(currentId, olderId);
    const { memory, sshManagement, artifacts, pipelineDefinitions, config } =
      this.services;
    const catalog = sshManagement.catalog.read();
    const sessions = sessionRecords(config.dataDir) || [];
    return {
      olderId,
      entries: older.entryCount || 0,
      capabilities: memory.db
        .prepare("SELECT COUNT(*) AS total FROM capabilities WHERE project_id=?")
        .get(olderId).total,
      sshAccess: [...catalog.keys, ...catalog.hosts].filter(
        (row) => row.projectId === olderId,
      ).length,
      artifacts: Object.values(artifacts.store.state.records).filter(
        (record) => record.projectId === olderId,
      ).length,
      verification: pipelineDefinitions.state.verification?.[olderId]?.length || 0,
      sessions: sessions.filter(
        ({ data }) =>
          data?.memory?.projectId === olderId ||
          data?.sshTools?.project?.projectId === olderId,
      ).length,
    };
  }
  /**
   * Merges `olderId` into `currentId` when the owner saw the current state
   * (`entries` is the older row's entry count they confirmed). Refuses a merge that
   * would mix SSH access of both projects or follow another recorded rebind.
   */
  async merge(currentId, { olderId, entries } = {}) {
    const { memory, projectRebind, sshManagement } = this.services;
    identifier(currentId);
    identifier(olderId);
    if (!memory.hasProject(olderId) && memory.reboundTo(olderId) === currentId) {
      // Already merged: finish an interrupted move, otherwise change nothing.
      if (projectRebind.remnants(olderId))
        await projectRebind.mergeDuplicate(olderId, memory.scopeOf(currentId));
      return memory.project(currentId);
    }
    const { older } = await this.pair(currentId, olderId);
    if (!Number.isSafeInteger(entries) || entries !== (older.entryCount || 0))
      throw changed();
    if (
      memory.reboundTo(olderId) ||
      (sshManagement.ownsProject(olderId) && sshManagement.ownsProject(currentId))
    )
      throw unsafe();
    if (!(await projectRebind.mergeDuplicate(olderId, memory.scopeOf(currentId))))
      throw unsafe();
    return memory.project(currentId);
  }
}
