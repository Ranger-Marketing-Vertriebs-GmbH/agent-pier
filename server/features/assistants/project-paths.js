import fs from "node:fs";
import path from "node:path";
import { assistantProblem } from "./assistant-validation.js";
import { fold } from "./team-plugin/tool-guard.js";
import { runFence } from "../memory/project-folders.js";

// Git internals hold credentials (remote URLs, hooks that run on the owner's next
// command): never read or written. Pipeline run worktrees belong to their runs.
const hidden = new Set([".git"].map(fold));
const readOnly = new Set([runFence].map(fold));
const refused = () => assistantProblem("projectPathRefused", 403);
const inside = (parent, child) =>
  child === parent ||
  child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const realpath = (value) => {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
};

/** The folder's real path; a missing or unreadable folder is "not found". */
export function realRoot(root) {
  const real = typeof root === "string" && path.isAbsolute(root) ? realpath(root) : null;
  if (!real || !fs.statSync(real).isDirectory()) throw assistantProblem("notFound", 404);
  return real;
}

// Segments below the root as given: relative to it, or absolute inside it (spelled
// with the registered or the real root). Never `..`, never a home, alias or URL form.
function segments(raw, roots) {
  if (raw === undefined || raw === "" || raw === ".") return [];
  if (
    typeof raw !== "string" ||
    raw.length > 4096 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]/.test(raw) ||
    /^(~|@|file:)/i.test(raw)
  )
    throw refused();
  let relative = raw;
  if (path.isAbsolute(raw)) {
    const root = roots.find((r) => inside(r, raw));
    if (!root) throw refused();
    relative = raw.slice(root.length);
  }
  const parts = relative.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw refused();
  return parts;
}

function protectedParts(parts, write) {
  return parts.some(
    (part) => hidden.has(fold(part)) || (write && readOnly.has(fold(part))),
  );
}

/**
 * Resolves `raw` inside a granted project folder, with the real path checked on
 * every call: symbolic links may point anywhere inside the folder, never out of it,
 * into `.git` or into `protectedRoots` (AgentPier's own data directory). Case
 * variants (".GIT") are caught by folding every segment, before and after links are
 * resolved. Returns the real target (or, for a target that does not exist yet, the
 * real parent joined with the missing names), its relative POSIX path and whether
 * it exists. Refuses with `projectPathRefused` (403) otherwise.
 */
export function projectTarget(root, raw, { write = false, protectedRoots = [] } = {}) {
  const real = realRoot(root);
  const parts = segments(raw, [...new Set([path.resolve(root), real])]);
  if (protectedParts(parts, write)) throw refused();
  // The deepest existing ancestor decides where links lead.
  let found = real,
    missing = [];
  for (let i = parts.length; i >= 0; i--) {
    const resolved = realpath(path.join(real, ...parts.slice(0, i)));
    if (resolved) {
      found = resolved;
      missing = parts.slice(i);
      break;
    }
  }
  const target = path.join(found, ...missing);
  if (!inside(real, found)) throw refused();
  const relative = path.relative(real, target).split(path.sep).filter(Boolean);
  if (protectedParts(relative, write)) throw refused();
  for (const root of protectedRoots) {
    const guarded = realpath(root) || root;
    if (inside(guarded, target) || (write && inside(target, guarded))) throw refused();
  }
  return {
    root: real,
    real: target,
    relative: relative.join("/"),
    exists: !missing.length,
  };
}
