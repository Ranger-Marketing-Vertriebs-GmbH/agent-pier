// The live `projects.changed` signal topic, owner only: `changed` once the project
// list of the projects page changed, that is a knowledge project row (registered,
// renamed, moved, merged or removed, by the owner, a session, a pipeline run or an
// agent creating its own project) or the saved repositories. The page reads its
// sources (GET /api/memory/projects, GET /api/repositories) again once per `changed`;
// they read the folders' Git remotes, so they are not pushed. AgentBus projects have
// their own topic (agentbus.changed).
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
 * `services.memory` that changed the rows, and after each save of the repositories.
 * Rows are compared only while a page follows the topic; a failing read is logged
 * and signals, the write stands.
 */
export function watchProjectWrites(services, hub) {
  const { memory, repositories } = services;
  let rows = null;
  const watched = () => hub.named("projects.changed").length > 0;
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
  for (const method of PROJECT_ROW_WRITES) after(memory, method, rowsChanged);
  after(repositories, "save", () => {
    if (watched()) hub.invalidate("projects.changed");
  });
}
