import fs from "node:fs";
import path from "node:path";
import { problem } from "./storage.js";

/** Check lexical containment and every existing path component before profile writes. */
export function assertUnlinkedPath(target, boundary, { outside, linked }) {
  const relative = path.relative(boundary, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw problem(outside, 409);
  let current = boundary;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw problem(linked, 409);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

/** JSONC parsing must not silently choose a value from duplicate object keys. */
export function assertUniqueJsonKeys(node) {
  if (node?.type === "object") {
    const keys = node.children.map((property) => property.children[0].value);
    if (new Set(keys).size !== keys.length)
      throw new Error("Duplicate configuration keys");
  }
  for (const child of node?.children || []) assertUniqueJsonKeys(child);
}
