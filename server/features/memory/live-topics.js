// The live `projects.changed` signal topic, owner only: `changed` once the project
// list of the projects page changed, that is a knowledge project row (registered,
// renamed, moved, merged or removed, by the owner, a session, a pipeline run or an
// agent creating its own project) or the saved repositories. The page reads its
// sources (GET /api/memory/projects, GET /api/repositories) again once per `changed`;
// they read the folders' Git remotes, so they are not pushed. A project deletion
// (ProjectDeletion) signals it as well when it starts, fails, is retried and ends, as
// the lists carry each folder's state and the deletions in progress. AgentBus
// projects have their own topic (agentbus.changed).
import { after } from "../sessions/live-state-topic.js";

const owner = (principal) => principal?.role === "owner";

/** The `projects.changed` signal topic definition for LiveHub#define. */
export function projectsChangedTopic() {
  return {
    name: "projects.changed",
    mode: "signal",
    authorize: owner,
    scopeKey: () => "owner",
  };
}

// ProjectMemory's writes that can add, rename, move or remove a project row.
export const PROJECT_ROW_WRITES = Object.freeze([
  "register",
  "adopt",
  "merge",
  "relocate",
  "removeEmpty",
]);

// What the list shows of the project rows; entry counts change with every memory
// write and are not followed.
const rowsOf = (memory) =>
  JSON.stringify(memory.projects().projects.map(({ id, name, cwd }) => [id, name, cwd]));

/**
 * Signals `projects.changed` on `hub` after the project-row writes of
 * `services.memory` that changed the rows (and every watched `pipeline.queue` after
 * each of them), and after each save of the repositories.
 * Rows are compared only while a page follows the topic; a failing read is logged
 * and signals, the write stands.
 */
export function watchProjectWrites(services, hub) {
  const { memory, repositories } = services;
  let rows = null;
  const watched = () => hub.named("projects.changed").length > 0;
  const registerChanged = () => {
    if (hub.named("autopilot.orders.changed").length)
      hub.invalidate("autopilot.orders.changed");
  };
  const rowsChanged = () => {
    if (!watched()) {
      rows = null;
      return;
    }
    let next;
    try {
      next = rowsOf(memory);
    } catch {
      console.error("AgentPier could not compare the project list.");
    }
    if (next !== undefined && next === rows) return;
    rows = next ?? null;
    hub.invalidate("projects.changed");
  };
  // A project's queue reads its project: one removed or merged away refuses, and the
  // tab hears it (an `error` frame) instead of showing the old queue.
  const queuesChanged = () => {
    if (hub.named("pipeline.queue").length) hub.invalidate("pipeline.queue");
  };
  for (const method of PROJECT_ROW_WRITES)
    after(memory, method, () => {
      registerChanged();
      rowsChanged();
      queuesChanged();
    });
  after(repositories, "save", () => {
    registerChanged();
    if (watched()) hub.invalidate("projects.changed");
  });
}

// The Knowledge tab's `memory.changed:<projectId>` signal topic, owner only: `changed`
// after every write to that project's entries (a new entry or an edit by the owner, a
// session's memory_write or memory_archive, archiving, restoring, forgetting) and after
// a merge or move of entries into or out of it. The tab then reads its entries page
// (GET /api/memory/projects/:id/entries) once.
export const MEMORY_PROJECT_PARAM = /[A-Za-z0-9][A-Za-z0-9_-]{0,99}/;

/** The `memory.changed:<projectId>` signal topic definition for LiveHub#define. */
export function memoryChangedTopic() {
  return {
    name: "memory.changed",
    mode: "signal",
    param: MEMORY_PROJECT_PARAM,
    authorize: owner,
    scopeKey: () => "owner",
  };
}

// ProjectMemory's entry writes, with the projects each one changes from its arguments.
const ENTRY_WRITES = Object.freeze({
  write: ([projectId]) => [projectId],
  archive: ([projectId]) => [projectId],
  forget: ([projectId]) => [projectId],
  adopt: ([fromId, scope]) => [fromId, scope?.id],
  move: ([fromId, scope]) => [fromId, scope?.id],
  merge: ([fromId, scope]) => [fromId, scope?.id],
});

/**
 * Signals `memory.changed:<projectId>` on `hub` after each entry write of
 * `services.memory` (whether it succeeded or not; a refused write reads the same
 * page again). Nothing is read here: only followers of that project hear it.
 */
export function watchMemoryWrites(services, hub) {
  const { memory } = services;
  for (const [method, projectsOf] of Object.entries(ENTRY_WRITES)) {
    const original = memory?.[method];
    if (typeof original !== "function") continue;
    memory[method] = function (...args) {
      const signal = () => {
        for (const id of new Set(projectsOf(args)))
          if (typeof id === "string" && hub.named("memory.changed", id).length)
            hub.invalidate("memory.changed", id);
      };
      let result;
      try {
        result = original.apply(this, args);
      } catch (error) {
        signal();
        throw error;
      }
      if (typeof result?.then === "function") result.then(signal, signal);
      else signal();
      return result;
    };
  }
}
