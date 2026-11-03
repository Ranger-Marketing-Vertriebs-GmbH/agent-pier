// Pure verdict over a pull request snapshot from pr-forge.js.

const MERGE_READY_STATES = new Set(["CLEAN", "HAS_HOOKS"]);
const SEPARATOR = "[/_.-]";

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

/** True when the branch names the ticket, with separators (or the ends) as boundaries. */
export function branchMatchesKey(branch, ticket) {
  const token = keyToken(ticket);
  if (!token || typeof branch !== "string") return false;
  const pattern = new RegExp(
    `(?:^|${SEPARATOR})${escapeRegExp(token)}(?:$|${SEPARATOR})`,
    "i",
  );
  return pattern.test(branch);
}
