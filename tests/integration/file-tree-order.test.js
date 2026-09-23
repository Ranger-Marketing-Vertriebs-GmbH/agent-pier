import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileNative } from "../../server/features/files/file-native.js";
import { openParent } from "../../server/features/files/file-stage.js";
import { scanTree } from "../../server/features/files/file-tree.js";

// readdir order differs per filesystem (ext4 hashes names with a per-volume seed),
// so feed scanTree reversed streams and require the same stable sibling order.
function reversedNative(native) {
  const pending = new Map();
  return {
    async run(operation, args) {
      if (operation !== "readDirectory") return native.run(operation, args);
      if (!pending.has(args.handle)) {
        const entries = [];
        let entry;
        while ((entry = await native.run(operation, args))) entries.push(entry);
        pending.set(args.handle, entries.reverse());
      }
      return pending.get(args.handle).shift() || null;
    },
  };
}

test("tree scans visit siblings in stable name order regardless of readdir order", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-tree-order-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tree = path.join(root, "tree");
  await fs.mkdir(path.join(tree, "b"), { recursive: true });
  for (const name of ["same", "first", "p", "a"])
    await fs.writeFile(path.join(tree, name), name);
  await fs.writeFile(path.join(tree, "b", "z"), "z");
  await fs.writeFile(path.join(tree, "b", "c"), "c");
  const native = new FileNative();
  t.after(() => native.close());
  const expected = ["", "a", "b", "first", "p", "same", "b/c", "b/z"];
  for (const candidate of [native, reversedNative(native)]) {
    const parent = await openParent(candidate, tree);
    try {
      const rows = await scanTree(candidate, parent, "tree");
      assert.deepEqual(
        rows.map((row) => row.relativePath),
        expected,
      );
    } finally {
      await parent.close();
    }
  }
});
