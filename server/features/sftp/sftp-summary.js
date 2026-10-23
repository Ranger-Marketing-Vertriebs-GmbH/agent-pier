import path from "node:path";
import { sftpLimits } from "./sftp-limits.js";
import { planSummary } from "./sftp-plan.js";
import { insideRoot } from "./sftp-remote-paths.js";

// How an SFTP plan and a finished job's result are reported to a coding session
// (sftp-session-tools.js) and an agent (agent-sftp.js): path lists capped by count
// and by bytes, so a result stays well inside the tool output budgets.
const posix = path.posix;

/** The deepest folder holding both paths (a rename's lock). */
export function commonFolder(a, b) {
  let folder = posix.dirname(a);
  while (!insideRoot(folder, b)) folder = posix.dirname(folder);
  return folder;
}

// Path lists share one UTF-8 budget so a result stays well inside the MCP server's
// 512 KiB output budget: the summary lists get 256 KiB, a result's `overwritten` 64.
const SUMMARY_BYTES = 256 * 1024;
const RESULT_BYTES = 64 * 1024;

/** Fills `lists` in order within `budget` bytes; `cut` counts what was left out. */
export function withinBudget(lists, budget) {
  let left = budget;
  const kept = {};
  const cut = {};
  for (const [key, paths] of Object.entries(lists)) {
    const keep = [];
    for (const item of paths) {
      const cost = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (cost > left) break;
      left -= cost;
      keep.push(item);
    }
    left = keep.length === paths.length ? left : 0;
    kept[key] = keep;
    cut[key] = paths.length - keep.length;
  }
  return { kept, cut };
}

/** The plan as a tool reports it: lists capped by count and by `SUMMARY_BYTES`. */
export function transferSummary(prepared, local) {
  const limit = sftpLimits.resultListLimit;
  const { operation, direction, kind, remotePath: base } = prepared.summary;
  const dirs = prepared.plan.deleteDirs;
  const planned = planSummary(prepared.plan, limit);
  const { kept, cut } = withinBudget(
    {
      create: planned.create,
      update: planned.update,
      delete: planned.delete,
      deleteDirs: dirs.slice(0, limit),
    },
    SUMMARY_BYTES,
  );
  return {
    ...planned,
    create: kept.create,
    update: kept.update,
    delete: kept.delete,
    more: {
      create: planned.more.create + cut.create,
      update: planned.more.update + cut.update,
      delete: planned.more.delete + cut.delete,
    },
    operation,
    direction,
    kind,
    remotePath: base,
    localPath: local.relative || ".",
    deleteDirs: kept.deleteDirs,
    moreDeleteDirs: Math.max(0, dirs.length - limit) + cut.deleteDirs,
  };
}

// A finished job's result with its `overwritten` list inside `RESULT_BYTES`.
export function budgetedResult(result) {
  if (!Array.isArray(result.overwritten)) return result;
  const { kept, cut } = withinBudget({ overwritten: result.overwritten }, RESULT_BYTES);
  return cut.overwritten
    ? { ...result, overwritten: kept.overwritten, moreOverwritten: cut.overwritten }
    : result;
}
