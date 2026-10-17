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
// GitHub rejects comments above 65,536 characters; stay well below.
const bodyBudget = 60_000;
const shownJobs = 30;

export const isAdvisoryJob = (name) =>
  !requiredChecks.includes(name) && !requiredInputs.some((pattern) => pattern.test(name));

export const failedAdvisoryJobs = (jobs) =>
  jobs
    .filter((job) => isAdvisoryJob(job.name) && failedConclusions.has(job.conclusion))
    .map(({ name, conclusion, html_url: url }) => ({
      name: plain(name),
      conclusion: plain(conclusion),
      url: link(url),
    }));

export function pullRequestNumbers(run) {
  const listed = (run.pull_requests || []).map((pull) => pull.number);
  if (listed.length) return listed;
  const match = queueRef.exec(run.head_branch || "");
  return run.event === "merge_group" && match ? [Number(match[1])] : [];
}

// Job and workflow names come from the run, which a fork's workflow file can
// name: strip everything that could leave the code span or mention someone.
// Format characters (bidi overrides, zero-width) go too.
const plain = (text) =>
  String(text ?? "")
    .replace(/\p{Cf}/gu, "")
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

const short = (sha) => `\`${plain(sha).slice(0, 7)}\``;
const failures = (entry) => (entry.failed?.length || 0) + (Number(entry.more) || 0);
const where = (entry) =>
  entry.event === "merge_group" && Number.isInteger(entry.pullRequest)
    ? `merge group containing #${entry.pullRequest}`
    : events[entry.event] || plain(entry.event);

// A red section counts until it is superseded: a pull request section by a newer
// head revision (a path-filtered workflow may never run again for it), or by a
// later green merge queue run of the same workflow, which runs the same jobs.
export function sectionStatus(entry, state, head) {
  if (!failures(entry)) return "green";
  if (entry.event !== "pull_request") return "red";
  if (head && entry.sha !== head) return "older";
  const queue = state[`${entry.workflow}/merge_group`];
  if (queue && !failures(queue) && queue.startedAt > entry.startedAt) return "cleared";
  return "red";
}

function renderSection(entry, status = "red", head = null) {
  const title = `**${plain(entry.workflow)}** (${where(entry)}) · ${short(entry.sha)} · ${linked("run", entry.runUrl)}`;
  const count = failures(entry);
  if (status === "green") return `${title}: all advisory jobs passed.`;
  if (status === "older")
    return `${title}: ${count} advisory job(s) failed on an older revision, superseded by ${short(head)}; not counted.`;
  if (status === "cleared")
    return `${title}: ${count} advisory job(s) failed here; the merge queue passed them since.`;
  return [
    title,
    ...entry.failed.map(
      (job) =>
        `- ${linked(`\`${plain(job.name)}\``, job.url)} (${plain(job.conclusion)})`,
    ),
    ...(entry.more ? [`- and ${entry.more} more`] : []),
  ].join("\n");
}

// At most `limit` failed jobs per section, in the comment and in its state, with
// names already shortened.
const clip = (state, limit) =>
  Object.fromEntries(
    Object.entries(state).map(([key, entry]) => {
      const failed = entry.failed || [];
      const more = (Number(entry.more) || 0) + Math.max(0, failed.length - limit);
      const shown = failed.slice(0, limit).map((job) => ({
        name: plain(job.name),
        conclusion: plain(job.conclusion),
        url: link(job.url),
      }));
      return [key, { ...entry, failed: shown, ...(more ? { more } : {}) }];
    }),
  );

export function renderComment(state, { head = null } = {}) {
  for (const limit of [shownJobs, 10, 3, 0]) {
    const body = renderBody(clip(state, limit), head);
    if (body.length < bodyBudget || limit === 0) return body;
  }
}

function renderBody(state, head) {
  const keys = Object.keys(state).sort();
  const statuses = keys.map((key) => sectionStatus(state[key], state, head));
  const red = statuses.includes("red");
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
    keys
      .map((key, index) => renderSection(state[key], statuses[index], head))
      .join("\n\n"),
    "",
  ].join("\n");
}

export function renderSummary(entry, pullRequests) {
  const target = pullRequests.length
    ? `Reported on ${pullRequests.map((number) => `#${number}`).join(", ")}.`
    : "No open pull request to report on.";
  const result = failures(entry)
    ? `Advisory jobs failed; fix before the next release.\n\n${renderSection(entry)}`
    : `All advisory jobs passed. ${renderSection(entry, "green")}`;
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

// Read, merge, write, then read again after a pause: a concurrent reporter may
// have written in between. The last attempt's write is checked as well; a
// result that still did not stick is reported as unverified, not as an error.
async function upsert({ api, repo, number, key, entry, head, sleep }) {
  const wanted = clip({ [key]: entry }, shownJobs)[key];
  for (let attempt = 1; ; attempt++) {
    const { own, state } = await ownComments(api, repo, number);
    const current = state[key];
    const newer = current && current.startedAt > entry.startedAt;
    if (!own.length && !failures(entry)) return "nothing to report";
    const merged = newer ? state : { ...state, [key]: wanted };
    const body = renderComment(merged, { head });
    const synced = own.length === 1 && own[0].body === body;
    if (synced)
      return attempt === 1 ? (newer ? "newer result kept" : "unchanged") : "updated";
    if (attempt > verifyAttempts) return "unverified";
    const [keep, ...extra] = own;
    try {
      if (keep) await api("PATCH", `/repos/${repo}/issues/comments/${keep.id}`, { body });
      else await api("POST", `/repos/${repo}/issues/${number}/comments`, { body });
    } catch (error) {
      // Deleted by a concurrent reporter between read and write: recreate.
      if (error.status !== 404) throw error;
      continue;
    }
    for (const comment of extra)
      await api("DELETE", `/repos/${repo}/issues/comments/${comment.id}`).catch(
        (error) => {
          if (error.status !== 404) throw error; // Already deleted elsewhere.
        },
      );
    await sleep(2000 + Math.floor(Math.random() * 3000));
  }
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
  const [queued] = run.event === "merge_group" ? pullRequestNumbers(run) : [];
  if (queued) entry.pullRequest = queued;
  const key = `${run.name}/${run.event}`;
  const pullRequests = [];
  const outcomes = {};
  for (const number of await findPullRequests(api, repository, run)) {
    const pull = await api("GET", `/repos/${repository}/pulls/${number}`);
    const head = pull.head?.sha || null;
    // A newer revision runs its own checks.
    if (run.event === "pull_request" && head !== run.head_sha) continue;
    outcomes[number] = await upsert({
      api,
      repo: repository,
      number,
      key,
      entry,
      head,
      sleep,
    });
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
      throw Object.assign(
        new Error(`${method} ${url}: HTTP ${response.status} ${await response.text()}`),
        { status: response.status },
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
