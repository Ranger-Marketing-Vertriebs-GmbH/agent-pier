import { folderState } from "../features/projects/deletion-paths.js";
import { deletionKey } from "./project-deletion.js";

/** The deletion records the project lists carry: path, state and error code. */
export const listedDeletions = (memory) =>
  memory.deletions.list().map(({ path, state, error }) => ({ path, state, error }));

/**
 * Each row with `folder` ("present", "missing" or "unavailable"; one stat per row, in
 * parallel) and `deletion` ({ state, error } while its folder is being deleted or a
 * deletion failed, else null). Rows meet records by deletionKey, not by the
 * written path.
 */
export async function annotateFolders(memory, rows, pathOf) {
  const records = new Map(memory.deletions.list().map((record) => [record.path, record]));
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
