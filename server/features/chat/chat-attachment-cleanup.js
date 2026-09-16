import { FileNative } from "../files/file-native.js";
import { ownedHandle } from "../files/file-stage.js";
import { scanTree, removeTree } from "../files/file-tree.js";

// Cleanup owns this worker and every handle it creates. Native traversal never
// follows links; removal stays relative to pinned parents even if names change.
export async function removeAttachmentTree(rootPath, parts) {
  const native = new FileNative();
  try {
    const root = await native.run("openRoot", { path: rootPath });
    const parent = ownedHandle(
      native,
      parts.length === 1
        ? root
        : await native.run("openLookup", {
            directory: root.handle,
            path: parts[0],
          }),
    );
    const name = parts.at(-1);
    const rows = await scanTree(native, parent, name);
    await removeTree(native, parent, name, rows);
  } catch (error) {
    // Missing or replaced entries are no longer ours to clean up.
    if (
      !["FILE_NOT_FOUND", "FILE_PATH_CHANGED", "FILE_CONFLICT_CHANGED"].includes(
        error.code,
      )
    )
      throw error;
  } finally {
    // Worker shutdown closes all root, lookup and stream handles, also on errors.
    await native.close();
  }
}
