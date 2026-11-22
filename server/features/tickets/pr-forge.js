// GitHub pull request access for ticket sequences: REST for listing and merging,
// GraphQL for status, reviews, auto-merge and the merge queue. Every call goes through
// requestJson (no redirects, timeout, size cap); errors carry only a code.
import { requestJson, TicketSourceError } from "./http-json.js";
import { branchMatchesKey } from "./pr-status.js";
import { httpUrl, plainLine } from "./ticket.js";

const MAX_CHECKS = 100;
const CHECK_NAME_LIMIT = 80;
const REF_LIMIT = 255;
const SHA = /^[0-9a-f]{40,64}$/i;
const MERGE_METHODS = new Set(["MERGE", "SQUASH", "REBASE"]);
const SUCCESS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILURE = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

export function graphqlUrl(apiBase) {
  const base = String(apiBase).replace(/\/+$/, "");
  if (base.endsWith("/api/v3")) return `${base.slice(0, -"/api/v3".length)}/api/graphql`;
  return `${base}/graphql`;
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function repoPath(access) {
  return `/repos/${encodeURIComponent(access.owner)}/${encodeURIComponent(access.repo)}`;
}

function rest(access, path, options = {}) {
  return requestJson({
    fetchImpl: access.fetchImpl,
    url: `${access.apiBase}${path}`,
    headers: headers(access.token),
    ...options,
  });
}

function graphqlError(errors) {
  // GraphQL reports rate limits and missing repositories with HTTP 200.
  if (errors.some((error) => error?.type === "RATE_LIMITED")) return "rateLimited";
  if (errors.some((error) => error?.type === "NOT_FOUND")) return "notFound";
  return "invalidResponse";
}

// A field path without list indexes, e.g. "repository.mergeQueue".
function fieldPath(error) {
  if (!Array.isArray(error?.path)) return null;
  return error.path.filter((part) => typeof part === "string").join(".");
}

/**
 * Runs a GraphQL request. Errors that concern only `optional` fields (paths such as
 * "repository.mergeQueue", which a token may not be allowed to read) leave the data in
 * use, and so does a FORBIDDEN answer for a `forbidden` field or one below it, whose
 * path is then added to `denied`; any other error decides the code.
 */
async function graphql(
  access,
  query,
  variables,
  { signal, optional = [], forbidden = [], denied = null } = {},
) {
  const { data } = await requestJson({
    fetchImpl: access.fetchImpl,
    url: graphqlUrl(access.apiBase),
    method: "POST",
    headers: headers(access.token),
    body: { query, variables },
    signal,
  });
  if (!data || typeof data !== "object") throw new TicketSourceError("invalidResponse");
  const result = data.data && typeof data.data === "object" ? data.data : null;
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const below = (path, field) => path === field || path?.startsWith(`${field}.`);
  const refused = (error) =>
    error?.type === "FORBIDDEN" &&
    forbidden.some((field) => below(fieldPath(error), field));
  const tolerated = (error) => optional.includes(fieldPath(error)) || refused(error);
  if (errors.length > 0 && !(result && errors.every(tolerated)))
    throw new TicketSourceError(graphqlError(errors));
  if (!result) throw new TicketSourceError("invalidResponse");
  for (const error of errors) if (refused(error)) denied?.add(fieldPath(error));
  return result;
}

function sameName(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

function fromThisRepo(access, pull) {
  const fullName = pull?.head?.repo?.full_name;
  return (
    typeof fullName === "string" && sameName(fullName, `${access.owner}/${access.repo}`)
  );
}

// GitHub's clock and the host's may differ; a PR opened right after the start still counts.
const SINCE_TOLERANCE_MS = 5 * 60_000;

function created(pull) {
  const time = Date.parse(pull?.created_at ?? "");
  return Number.isFinite(time) ? time : null;
}

function byBot(pull) {
  const user = pull?.user;
  return user?.type === "Bot" || /\[bot\]$/i.test(String(user?.login ?? ""));
}

function found(pull) {
  return {
    number: pull.number,
    url: httpUrl(pull.html_url),
    headRef: plainLine(pull.head.ref, REF_LIMIT),
  };
}

async function listPulls(access, { head, since, signal }) {
  const params = new URLSearchParams({
    state: "all",
    sort: "created",
    direction: "desc",
    per_page: "50",
  });
  if (head) params.set("head", `${access.owner}:${head}`);
  const { data } = await rest(access, `${repoPath(access)}/pulls?${params}`, { signal });
  if (!Array.isArray(data)) throw new TicketSourceError("invalidResponse");
  const after =
    since === undefined || since === null
      ? null
      : new Date(since).getTime() - SINCE_TOLERANCE_MS;
  return data.filter((pull) => {
    if (!pull || !Number.isInteger(pull.number) || typeof pull.head?.ref !== "string")
      return false;
    if (!fromThisRepo(access, pull)) return false;
    if (after === null) return true;
    const time = created(pull);
    return time !== null && Number.isFinite(after) && time >= after;
  });
}

/**
 * The ticket's pull request, from this repository only (not a fork) and, when `since` is
 * given, created no earlier than it (less a clock tolerance), so an older attempt's PR
 * never counts.
 * - `branch` known (AgentPier created it): only the PR with exactly that head, looked up
 *   with a `head=` query that does not depend on paging. No key search.
 * - Otherwise (a pipeline run whose PR link is unknown): the newest PR among the latest 50
 *   whose head names the key (`branchMatchesKey`) and whose author is not a bot.
 */
export async function findPullRequest(access, { key, branch, since, signal } = {}) {
  if (branch) {
    const pulls = await listPulls(access, { head: branch, since, signal });
    const exact = pulls.find((pull) => pull.head.ref === branch);
    return exact ? found(exact) : null;
  }
  if (!key) return null;
  const pulls = await listPulls(access, { since, signal });
  const match = pulls.find(
    (pull) => !byBot(pull) && branchMatchesKey(pull.head.ref, { key }),
  );
  return match ? found(match) : null;
}

/** The pull request number of a PR URL in this repository, or null. */
export function pullRequestByUrl(access, url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (access.host && !sameName(new URL(access.host).host, parsed.host)) return null;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d{0,8})\/?$/.exec(parsed.pathname);
  if (!match || !sameName(match[1], access.owner) || !sameName(match[2], access.repo))
    return null;
  return { number: Number(match[3]) };
}

const PULL_QUERY = `query($owner: String!, $repo: String!, $n: Int!) {
  repository(owner: $owner, name: $repo) {
    autoMergeAllowed
    viewerDefaultMergeMethod
    defaultBranchRef { name }
    mergeQueue { id }
    pullRequest(number: $n) {
      id number url state headRefName headRefOid baseRefName
      mergeable mergeStateStatus reviewDecision isInMergeQueue
      autoMergeRequest { enabledAt }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) {
        nodes {
          __typename
          ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $n) }
          ... on StatusContext { context state isRequired(pullRequestNumber: $n) }
        }
      } } } } }
    }
  }
}`;

const QUEUE_QUERY = `query($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) { mergeQueue(branch: $branch) { id } }
}`;

function checkState(node) {
  if (node.__typename === "CheckRun") {
    if (node.status !== "COMPLETED") return "pending";
    if (SUCCESS.has(node.conclusion)) return "success";
    return FAILURE.has(node.conclusion) || node.conclusion === "STALE"
      ? "failure"
      : "pending";
  }
  if (SUCCESS.has(node.state)) return "success";
  return FAILURE.has(node.state) ? "failure" : "pending";
}

function checksOf(pull) {
  const nodes =
    pull.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  if (!Array.isArray(nodes)) return [];
  const checks = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const raw = node.__typename === "CheckRun" ? node.name : node.context;
    checks.push({
      name: plainLine(raw, CHECK_NAME_LIMIT),
      state: checkState(node),
      required: node.isRequired === true,
    });
    if (checks.length >= MAX_CHECKS) break;
  }
  return checks;
}

function word(value) {
  return typeof value === "string" && /^[A-Z_]{1,40}$/.test(value) ? value : null;
}

// GitHub refuses check data a token may not read with FORBIDDEN errors next to the
// pull request: on this field as a whole (a fine-grained token without "Commit
// statuses: read"), or on single check runs below it (fine-grained tokens cannot be
// given "Checks: read" at all, so GitHub Actions results stay hidden from them).
const CHECKS_PATH = "repository.pullRequest.commits.nodes.commit.statusCheckRollup";
const ROLLUP_STATES = {
  SUCCESS: "success",
  FAILURE: "failure",
  ERROR: "failure",
  PENDING: "pending",
  EXPECTED: "pending",
};
// The name of the one check that stands for GitHub's overall state of all checks.
export const ROLLUP_CHECK = "checks";

/**
 * The checks of a pull request whose check data GitHub refused in part or in whole:
 * the rollup's overall state as one check that is not required, or null when that is
 * hidden too. The overall state covers every check, so it never passes while a single
 * one is red or pending.
 */
function summaryChecks(pull) {
  const rollup = pull.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const state = ROLLUP_STATES[rollup?.state];
  return state ? [{ name: ROLLUP_CHECK, state, required: false }] : null;
}

/**
 * The pull request as the sequence engine needs it. When the token may not read the
 * single checks, `checks` is their overall state (see summaryChecks). When it may not
 * read that either, `checksUnreadable` is true: state, head and reviews are still
 * valid, `checks` is empty and says nothing, so such a PR must never be merged on its
 * checks.
 */
export async function readPullRequest(access, number, { signal } = {}) {
  const variables = { owner: access.owner, repo: access.repo, n: Number(number) };
  const denied = new Set();
  const data = await graphql(access, PULL_QUERY, variables, {
    signal,
    optional: ["repository.mergeQueue"],
    forbidden: [CHECKS_PATH],
    denied,
  });

  const repository = data.repository;
  const pull = repository?.pullRequest;
  if (!repository || !pull) throw new TicketSourceError("notFound");
  if (typeof pull.id !== "string" || !Number.isInteger(pull.number))
    throw new TicketSourceError("invalidResponse");
  const state = ["OPEN", "MERGED", "CLOSED"].includes(pull.state) ? pull.state : null;
  if (!state) throw new TicketSourceError("invalidResponse");
  const defaultBranch = plainLine(repository.defaultBranchRef?.name, REF_LIMIT);
  const baseRef = plainLine(pull.baseRefName, REF_LIMIT);
  // The field refused as a whole carries no state of its own.
  const partly = denied.size > 0 && !denied.has(CHECKS_PATH);
  const summary = partly ? summaryChecks(pull) : null;
  let mergeQueue = Boolean(repository.mergeQueue?.id);
  // The query above reads the default branch's queue; another base needs its own.
  if (baseRef && baseRef !== defaultBranch) {
    const queue = await graphql(
      access,
      QUEUE_QUERY,
      { owner: access.owner, repo: access.repo, branch: baseRef },
      { signal, optional: ["repository.mergeQueue"] },
    );
    mergeQueue = Boolean(queue.repository?.mergeQueue?.id);
  }
  const method = repository.viewerDefaultMergeMethod;
  return {
    id: pull.id,
    number: pull.number,
    url: httpUrl(pull.url),
    state,
    headRef: plainLine(pull.headRefName, REF_LIMIT),
    headSha: SHA.test(pull.headRefOid ?? "") ? pull.headRefOid : "",
    baseRef,
    mergeable: word(pull.mergeable),
    mergeStateStatus: word(pull.mergeStateStatus),
    reviewDecision: word(pull.reviewDecision),
    autoMerge: Boolean(pull.autoMergeRequest),
    inMergeQueue: pull.isInMergeQueue === true,
    checks: summary ?? (denied.size > 0 ? [] : checksOf(pull)),
    checksUnreadable: denied.size > 0 && !summary,
    repo: {
      autoMergeAllowed: repository.autoMergeAllowed === true,
      mergeQueue,
      defaultMergeMethod: MERGE_METHODS.has(method) ? method : "MERGE",
      defaultBranch,
    },
  };
}

async function mutate(access, mutation, input) {
  await graphql(
    access,
    `mutation($input: ${mutation.input}!) { ${mutation.name}(input: $input) { clientMutationId } }`,
    { input },
  );
}

// Arming without the head the verdict saw could merge a later, unchecked push.
function headOid(pr) {
  if (!SHA.test(pr?.headSha ?? "")) throw new TicketSourceError("invalidResponse");
  return pr.headSha;
}

export async function enableAutoMerge(access, pr) {
  return mutate(
    access,
    { name: "enablePullRequestAutoMerge", input: "EnablePullRequestAutoMergeInput" },
    {
      pullRequestId: pr.id,
      mergeMethod: pr.repo.defaultMergeMethod,
      expectedHeadOid: headOid(pr),
    },
  );
}

export async function disableAutoMerge(access, pr) {
  return mutate(
    access,
    { name: "disablePullRequestAutoMerge", input: "DisablePullRequestAutoMergeInput" },
    { pullRequestId: pr.id },
  );
}

export async function enqueue(access, pr) {
  return mutate(
    access,
    { name: "enqueuePullRequest", input: "EnqueuePullRequestInput" },
    { pullRequestId: pr.id, expectedHeadOid: headOid(pr) },
  );
}

export async function dequeue(access, pr) {
  return mutate(
    access,
    { name: "dequeuePullRequest", input: "DequeuePullRequestInput" },
    { id: pr.id },
  );
}

/** Merges exactly the head the verdict saw; GitHub refuses when the head moved. */
export async function mergePullRequest(access, pr) {
  const sha = headOid(pr);
  await rest(access, `${repoPath(access)}/pulls/${encodeURIComponent(pr.number)}/merge`, {
    method: "PUT",
    body: { sha, merge_method: pr.repo.defaultMergeMethod.toLowerCase() },
  });
}

export async function defaultBranch(access, { signal } = {}) {
  const { data } = await rest(access, repoPath(access), { signal });
  const name = plainLine(data?.default_branch, REF_LIMIT);
  if (!name) throw new TicketSourceError("invalidResponse");
  return name;
}
