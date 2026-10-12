import { createHash } from "node:crypto";
import path from "node:path";
import { splitCommand } from "./exec-allowlist-policy.js";

// How OpenClaw 2026.9.8 writes an allow-always (dist: exec-approvals-allow-always,
// exec-command-resolution): one path entry per program whose `argPattern` hashes
// the working directory and the program's arguments, plus a companion
// `=node-command:<sha256(command.trim()) hex[0,16]>`. Nothing in the file links
// the two; the command text of the request does. Deleting the path entry alone
// makes the command ask again; the companion grants nothing by itself
// (docs/assistant-shell-qualification.md (a)).
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const bytes = (value) => Buffer.byteLength(value, "utf8");

/** OpenClaw's companion pattern for a command, or null for an empty one. */
export function nodeCommandPattern(command) {
  const text = typeof command === "string" ? command.trim() : "";
  return text ? `=node-command:${sha256(text).slice(0, 16)}` : null;
}

/** OpenClaw's cwd-bound argument pattern of one program's argv. */
export function cwdArgvPattern(argv, cwd) {
  const dir = path.posix.normalize(cwd).replaceAll("\\", "/");
  const args = argv.slice(1);
  const subject = `${bytes(dir)}\0${dir}\0${args.length}\0${args
    .map((arg) => `${bytes(arg)}\0${arg}\0`)
    .join("")}`;
  return `sha256:cwd-argv:v1:${sha256(subject)}`;
}

/**
 * What one allow-always that OpenClaw answered itself wrote, from the exec action
 * AgentPier kept: the companion pattern and the argument patterns of its programs.
 * Null for an action OpenClaw did not answer with allow-always.
 */
export function allowAlwaysGroup(action) {
  const { payload, result } = action;
  if (payload?.action !== "exec" || result?.decision !== "allow-always") return null;
  // AgentPier answered it (exec-decisions.js): its own entries are keyed by id.
  if (result.resolvedAs) return null;
  const argvs = payload.cwd ? splitCommand(payload.command) || [] : [];
  return {
    command: payload.command,
    cwd: payload.cwd,
    requestedAt: action.createdAt,
    companion: nodeCommandPattern(payload.command),
    argPatterns: new Set(argvs.map((argv) => cwdArgvPattern(argv, payload.cwd))),
  };
}

/** The latest group an OpenClaw entry belongs to, or undefined. */
export function groupOf(entry, groups) {
  if (entry.source !== "allow-always") return undefined;
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (entry.pattern === group.companion) return group;
    if (typeof entry.argPattern === "string" && group.argPatterns.has(entry.argPattern))
      return group;
  }
  return undefined;
}
