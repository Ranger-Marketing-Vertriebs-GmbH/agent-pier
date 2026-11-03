// Pure verdict over a pull request snapshot from pr-forge.js.

// UNSTABLE: mergeable, only a check outside the counted (required) ones is not green.
const MERGE_READY_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
// Branches that name versions, releases or reverts, never a ticket's work.
const FOREIGN_PREFIXES = new Set(["release", "releases", "dependabot", "renovate"]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The checks that decide: the required ones when the repository marks any, else every
 * check (a repository without branch protection still has meaningful CI).
 */
function countedChecks(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const required = list.filter((check) => check.required);
  return required.length > 0 ? required : list;
}

export function prVerdict(snapshot) {
  const status =
    snapshot.state === "MERGED"
      ? "merged"
      : snapshot.state === "CLOSED"
        ? "closed"
        : "open";
  const counted = countedChecks(snapshot.checks);
  const failed = counted
    .filter((check) => check.state === "failure")
    .map((check) => check.name);
  // A failed check is final for its round; pending only wins over passed.
  let checks = "passed";
  if (failed.length > 0) checks = "failed";
  else if (counted.some((check) => check.state !== "success")) checks = "pending";
  const changesRequested = snapshot.reviewDecision === "CHANGES_REQUESTED";
  const reviewBlocks = changesRequested || snapshot.reviewDecision === "REVIEW_REQUIRED";
  const mergeReady =
    status === "open" &&
    checks === "passed" &&
    !reviewBlocks &&
    MERGE_READY_STATES.has(snapshot.mergeStateStatus);
  return {
    status,
    checks,
    failed,
    changesRequested,
    reviewBlocks,
    headSha: snapshot.headSha,
    mergeReady,
  };
}

/** The part of a ticket key a branch name carries: the issue number or the Plane key. */
export function keyToken(ticket) {
  const key = String(ticket?.key ?? "");
  const github = /#([1-9]\d{0,8})$/.exec(key);
  if (ticket?.source === "github" || (!ticket?.source && github))
    return github ? github[1] : "";
  return key;
}

/**
 * True when the branch names the ticket: the last path segment starts with the key as a
 * whole token (followed by its end, "-" or "_"; "." is no boundary, so "node-12.x" or
 * "4.17.12" never match #12). Release, dependency-bot and revert branches never match.
 */
export function branchMatchesKey(branch, ticket) {
  const token = keyToken(ticket);
  if (!token || typeof branch !== "string" || !branch) return false;
  const segments = branch.split("/");
  const first = segments[0].toLowerCase();
  // GitHub names a revert branch "revert-<pr>-<original branch>".
  if (first.startsWith("revert-")) return false;
  if (segments.length > 1 && FOREIGN_PREFIXES.has(first)) return false;
  const last = segments.at(-1);
  return new RegExp(`^${escapeRegExp(token)}(?:$|[-_])`, "i").test(last);
}
