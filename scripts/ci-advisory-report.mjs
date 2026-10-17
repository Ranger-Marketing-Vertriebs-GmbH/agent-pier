import fs from "node:fs";
import { pathToFileURL } from "node:url";

// Reports red advisory CI jobs on the pull request (AGENTPIER-105). Runs from
// .github/workflows/advisory-report.yml after Verify, Assistant runtime or
// Assistant runtime (queue) completes for a pull request or a merge group. It
// reads job results through the API only and keeps one comment per pull request,
// found by `marker`; each workflow and event owns one section of it.

export const marker = "<!-- agentpier:advisory-checks -->";

// The branch rules of main (see docs/testing.md). Every other job of a watched
// workflow is advisory, except the jobs whose result already surfaces in a
// required check.
export const requiredChecks = [
  "backend (ubuntu-latest, 24)",
  "browser (chromium)",
  "secrets",
];
const requiredInputs = [/^select tests$/, /^browser \(chromium\) shard /];
const failedConclusions = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "startup_failure",
]);
const events = { pull_request: "pull request", merge_group: "merge queue" };
const queueRef = /^gh-readonly-queue\/[^/]+(?:\/[^/]+)*\/pr-(\d+)-[0-9a-f]{40}$/;
const verifyAttempts = 3;

export const isAdvisoryJob = (name) =>
  !requiredChecks.includes(name) && !requiredInputs.some((pattern) => pattern.test(name));

export const failedAdvisoryJobs = (jobs) =>
  jobs
    .filter((job) => isAdvisoryJob(job.name) && failedConclusions.has(job.conclusion))
    .map(({ name, conclusion, html_url: url }) => ({ name, conclusion, url }));

export function pullRequestNumbers(run) {
  const listed = (run.pull_requests || []).map((pull) => pull.number);
  if (listed.length) return listed;
  const match = queueRef.exec(run.head_branch || "");
  return run.event === "merge_group" && match ? [Number(match[1])] : [];
}

// Job and workflow names come from the run, which a fork's workflow file can
// name: strip everything that could leave the code span or mention someone.
const plain = (text) =>
  String(text ?? "")
    .replace(/[`<>[\]\\|@\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
const link = (url) =>
  /^https:\/\/github\.com\/[\w./%-]+$/.test(String(url ?? "")) ? url : null;
const linked = (text, url) => (link(url) ? `[${text}](${url})` : text);

export function readState(body) {
  const match = /<!-- state:([A-Za-z0-9+/=]*) -->/.exec(String(body ?? ""));
  if (!match) return {};
  try {
    const state = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

function renderSection(entry) {
  const head = `**${plain(entry.workflow)}** (${events[entry.event] || plain(entry.event)}) · \`${plain(entry.sha).slice(0, 7)}\` · ${linked("run", entry.runUrl)}`;
  if (!entry.failed?.length) return `${head}: all advisory jobs passed.`;
  return [
    head,
    ...entry.failed.map(
      (job) =>
        `- ${linked(`\`${plain(job.name)}\``, job.url)} (${plain(job.conclusion)})`,
    ),
  ].join("\n");
}

export function renderComment(state) {
  const entries = Object.keys(state)
    .sort()
    .map((key) => state[key]);
  const red = entries.some((entry) => entry.failed?.length);
  const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
  return [
    marker,
    `<!-- state:${encoded} -->`,
    red
      ? "### :x: Advisory checks failed: fix before the next release"
      : "### :white_check_mark: All advisory checks are green again",
    "",
    red
      ? "These checks do not block the merge, but a release needs the full suite green. This comment is updated by later runs."
      : "Every advisory job that was red on this pull request has passed since.",
    "",
    entries.map(renderSection).join("\n\n"),
    "",
  ].join("\n");
}

export function renderSummary(entry, pullRequests) {
  const target = pullRequests.length
    ? `Reported on ${pullRequests.map((number) => `#${number}`).join(", ")}.`
    : "No open pull request to report on.";
  const result = entry.failed.length
    ? `Advisory jobs failed; fix before the next release.\n\n${renderSection(entry)}`
    : `All advisory jobs passed. ${renderSection(entry)}`;
  return `## Advisory checks\n\n${result}\n\n${target}\n`;
}

async function paged(api, url, pick = (page) => page) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const batch = pick(
      await api("GET", `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`),
    );
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function findPullRequests(api, repo, run) {
  const numbers = pullRequestNumbers(run);
  if (numbers.length || run.event !== "pull_request") return numbers;
  // Runs of fork pull requests list no pull request; look it up by head.
  const owner = run.head_repository?.owner?.login;
  if (!owner || !run.head_branch) return [];
  const head = encodeURIComponent(`${owner}:${run.head_branch}`);
  const pulls = await api(
    "GET",
    `/repos/${repo}/pulls?head=${head}&state=open&per_page=100`,
  );
  return pulls
    .filter((pull) => pull.head?.sha === run.head_sha)
    .map((pull) => pull.number);
}

// Every marker comment the workflow token wrote; a forged marker from anyone
// else is ignored. Two reporters racing can each create one, so the states merge
// (newest run per section wins) and the oldest comment is kept.
async function ownComments(api, repo, number) {
  const comments = await paged(api, `/repos/${repo}/issues/${number}/comments`);
  const own = comments.filter(
    (comment) =>
      comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(marker),
  );
  const state = {};
  for (const comment of own)
    for (const [key, entry] of Object.entries(readState(comment.body)))
      if (!state[key] || state[key].startedAt < entry.startedAt) state[key] = entry;
  return { own, state };
}

async function upsert({ api, repo, number, key, entry, sleep }) {
  for (let attempt = 1; attempt <= verifyAttempts; attempt++) {
    const { own, state } = await ownComments(api, repo, number);
    const current = state[key];
    if (current && current.startedAt > entry.startedAt) return "newer result kept";
    if (!own.length && !entry.failed.length) return "nothing to report";
    const synced = own.length === 1 && JSON.stringify(current) === JSON.stringify(entry);
    if (synced) return attempt === 1 ? "unchanged" : "updated";
    const body = renderComment({ ...state, [key]: entry });
    const [keep, ...extra] = own;
    if (keep) await api("PATCH", `/repos/${repo}/issues/comments/${keep.id}`, { body });
    else await api("POST", `/repos/${repo}/issues/${number}/comments`, { body });
    for (const comment of extra)
      await api("DELETE", `/repos/${repo}/issues/comments/${comment.id}`);
    // Let a concurrent reporter finish its write, then check that ours survived.
    await sleep(2000 + Math.floor(Math.random() * 3000));
  }
  return "updated";
}

export async function report({ api, repository, run, sleep = defaultSleep }) {
  if (!events[run.event]) return { skipped: `event ${run.event}` };
  if (run.conclusion === "cancelled") return { skipped: "run cancelled or superseded" };
  const jobs = await paged(
    api,
    `/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt || 1}/jobs`,
    (page) => page.jobs,
  );
  const entry = {
    workflow: run.name,
    event: run.event,
    sha: run.head_sha,
    runUrl: run.html_url,
    startedAt: run.run_started_at || run.created_at,
    failed: failedAdvisoryJobs(jobs),
  };
  const key = `${run.name}/${run.event}`;
  const pullRequests = [];
  const outcomes = {};
  for (const number of await findPullRequests(api, repository, run)) {
    if (run.event === "pull_request") {
      const pull = await api("GET", `/repos/${repository}/pulls/${number}`);
      if (pull.head?.sha !== run.head_sha) continue; // A newer revision runs.
    }
    outcomes[number] = await upsert({ api, repo: repository, number, key, entry, sleep });
    pullRequests.push(number);
  }
  return { entry, pullRequests, outcomes, summary: renderSummary(entry, pullRequests) };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function githubApi({
  token,
  baseUrl = "https://api.github.com",
  fetch = globalThis.fetch,
}) {
  return async (method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok)
      throw new Error(
        `${method} ${url}: HTTP ${response.status} ${await response.text()}`,
      );
    return response.status === 204 ? null : response.json();
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { workflow_run: run } = JSON.parse(
    fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  const api = githubApi({
    token: process.env.GITHUB_TOKEN,
    baseUrl: process.env.GITHUB_API_URL,
  });
  const result = await report({ api, repository: process.env.GITHUB_REPOSITORY, run });
  const text = result.summary || `Advisory report skipped: ${result.skipped}.\n`;
  console.log(text, result.outcomes ? JSON.stringify(result.outcomes) : "");
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
