import fs from "node:fs";
import path from "node:path";
import { fold, repairs, workspaceId } from "./team-plugin/tool-guard.js";

const present = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};
/** Whether a workspace-relative path is MEMORY.md or below memory/. */
export const isMemory = (relative) => {
  const first = fold(relative.split("/")[0]);
  return first === "memory" || first === "memory.md";
};
/**
 * Whether a workspace-relative write target of a lead's task is (or may be) the
 * member's memory, which such a task never writes. Every spelling the plugin's write
 * guard repairs is checked, and on disk the target is resolved through links, the
 * way the guard identifies bootstrap files. Whatever cannot be shown to stay outside
 * memory, inside the member's own workspace, counts as memory.
 */
export function memoryTarget(root, runtimeAgentId, target) {
  const forms = repairs(String(target)).map((form) =>
    path.posix.normalize(form.replaceAll("\\", "/")).replace(/^(\.\/)+/, ""),
  );
  if (forms.some((form) => isMemory(form) || form === ".." || form.startsWith("../")))
    return true;
  const id = workspaceId(runtimeAgentId);
  if (!root || !id) return !id;
  try {
    const own = path.join(root, id);
    // No workspace yet: nothing on disk can link into memory.
    if (!fs.existsSync(own)) return false;
    const real = fs.realpathSync(own);
    return forms.some((form) => {
      // The deepest existing ancestor (a dangling link included) decides where the
      // write really lands.
      let probe = path.join(own, form);
      const rest = [];
      while (!present(probe) && probe !== own) {
        rest.unshift(path.basename(probe));
        probe = path.dirname(probe);
      }
      const dangling = fs.lstatSync(probe).isSymbolicLink() && !fs.existsSync(probe);
      const base = dangling
        ? path.resolve(fs.realpathSync(path.dirname(probe)), fs.readlinkSync(probe))
        : fs.realpathSync(probe);
      const landed = path.join(base, ...rest);
      const relative = path.relative(real, landed).split(path.sep).join("/");
      return !relative || relative.startsWith("..") || isMemory(relative);
    });
  } catch {
    return true;
  }
}

// Whether a workspace-relative path lies in the copy of the lead's memory.
const inLeadMirror = (relative) => {
  const parts = relative.split("/").map(fold);
  return parts[0] === "memory" && parts[1] === "lead";
};
/**
 * Whether a temporary member's write lands in its own memory: every spelling the
 * write guard repairs, resolved on disk through links, stays inside the member's own
 * workspace, in MEMORY.md or below memory/, and never in the copy of its lead's
 * memory (memory/lead/, member-memory.js). Anything that cannot be shown is refused.
 */
export function ownMemoryTarget(root, runtimeAgentId, target) {
  const forms = repairs(String(target)).map((form) =>
    path.posix.normalize(form.replaceAll("\\", "/")).replace(/^(\.\/)+/, ""),
  );
  const id = workspaceId(runtimeAgentId);
  if (
    !root ||
    !id ||
    !forms.length ||
    forms.some(
      (form) =>
        form === ".." || form.startsWith("../") || !isMemory(form) || inLeadMirror(form),
    )
  )
    return false;
  try {
    const own = path.join(root, id);
    if (!fs.existsSync(own)) return false;
    const real = fs.realpathSync(own);
    return forms.every((form) => {
      let probe = path.join(own, form);
      const rest = [];
      while (!present(probe) && probe !== own) {
        rest.unshift(path.basename(probe));
        probe = path.dirname(probe);
      }
      // A link anywhere on the way may point elsewhere: never followed for a write.
      if (fs.lstatSync(probe).isSymbolicLink()) return false;
      const landed = path.join(fs.realpathSync(probe), ...rest);
      const relative = path.relative(real, landed).split(path.sep).join("/");
      return (
        !!relative &&
        !relative.startsWith("..") &&
        isMemory(relative) &&
        !inLeadMirror(relative)
      );
    });
  } catch {
    return false;
  }
}
