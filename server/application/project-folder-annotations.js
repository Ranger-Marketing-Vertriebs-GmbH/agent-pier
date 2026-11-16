import { waitsForAgents } from "../features/projects/deletion-errors.js";
import { folderState } from "../features/projects/deletion-paths.js";
import { deletionKey } from "./project-deletion.js";

// A deletion that only waits for the agents no longer stands for its folder: its
// projects are gone, and a project registered there since is another one.
const shown = (memory) =>
  memory.deletions.list().filter((record) => !waitsForAgents(record));

/** The deletion records the project lists carry: path, state and error code. */
export const listedDeletions = (memory) =>
  shown(memory).map(({ path, state, error }) => ({ path, state, error }));

/**
 * Each row with `folder` ("present", "missing" or "unavailable"; one stat per row, in
 * parallel) and `deletion` ({ state, error } while its folder is being deleted or a
 * deletion failed, else null). Rows meet records by deletionKey, not by the
 * written path.
 */
export async function annotateFolders(memory, rows, pathOf) {
  const records = new Map(shown(memory).map((record) => [record.path, record]));
  return Promise.all(
    rows.map(async (row) => {
      const record = records.size ? records.get(deletionKey(pathOf(row))) : undefined;
      return {
        ...row,
        folder: await folderState(pathOf(row)),
        deletion: record ? { state: record.state, error: record.error } : null,
      };
    }),
  );
}
