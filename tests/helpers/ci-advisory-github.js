// Fixtures for scripts/ci-advisory-report.mjs: workflow runs, jobs and an
// in-memory GitHub REST API with the few endpoints the reporter uses.

export const bot = { login: "github-actions[bot]", type: "Bot" };

let jobId = 1000;
export const job = (name, conclusion = "success") => ({
  name,
  conclusion,
  html_url: `https://github.com/o/r/actions/runs/7/job/${jobId++}`,
});
export const verifyJobs = (overrides = {}) =>
  [
    "select tests",
    "backend (ubuntu-latest, 24)",
    "backend (macos-latest, 24)",
    "browser (chromium) shard 1/4",
    "browser (chromium)",
    "browser (webkit) shard 1/5",
    "browser (webkit)",
    "native filesystem matrix (ubuntu-latest)",
  ].map((name) => job(name, overrides[name]));
export const run = (fields = {}) => ({
  id: 7,
  run_attempt: 1,
  name: "Verify",
  event: "pull_request",
  conclusion: "failure",
  head_sha: "a".repeat(40),
  head_branch: "feat/x",
  html_url: "https://github.com/o/r/actions/runs/7",
  run_started_at: "2026-10-17T10:00:00Z",
  pull_requests: [{ number: 12 }],
  head_repository: { owner: { login: "o" } },
  ...fields,
});

export function fakeGitHub({
  jobs = verifyJobs(),
  headSha = "a".repeat(40),
  pulls = [],
  failures = [],
} = {}) {
  const comments = [];
  const calls = [];
  let nextId = 100;
  const api = async (method, url, body) => {
    calls.push(`${method} ${url}`);
    // A failure applies once, to the first matching call: { method, status }.
    const failure = failures.find(
      (candidate) => !candidate.used && candidate.method === method,
    );
    if (failure) {
      failure.used = true;
      failure.before?.();
      throw Object.assign(new Error(`HTTP ${failure.status}`), {
        status: failure.status,
      });
    }
    const route = url.replace(/^\/repos\/o\/r/, "");
    if (method === "GET" && /^\/actions\/runs\/\d+\/attempts\/\d+\/jobs/.test(route))
      return { total_count: jobs.length, jobs };
    if (method === "GET" && /^\/pulls\/\d+$/.test(route))
      return { number: Number(route.split("/")[2]), head: { sha: headSha } };
    if (method === "GET" && route.startsWith("/pulls?")) return pulls;
    if (method === "GET" && /^\/issues\/\d+\/comments/.test(route))
      return comments.filter((comment) => comment.issue === Number(route.split("/")[2]));
    if (method === "POST" && /^\/issues\/\d+\/comments$/.test(route)) {
      const comment = {
        id: nextId++,
        issue: Number(route.split("/")[2]),
        user: bot,
        body: body.body,
      };
      comments.push(comment);
      return comment;
    }
    const id = Number(route.split("/").at(-1));
    const comment = comments.find((candidate) => candidate.id === id);
    if (method === "GET" && route.startsWith("/issues/comments/")) return comment;
    if (method === "PATCH" && route.startsWith("/issues/comments/")) {
      comment.body = body.body;
      return comment;
    }
    if (method === "DELETE" && route.startsWith("/issues/comments/")) {
      comments.splice(comments.indexOf(comment), 1);
      return null;
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { api, comments, calls };
}
export const options = (github, workflowRun, extra = {}) => ({
  api: github.api,
  repository: "o/r",
  run: workflowRun,
  sleep: async () => {},
  ...extra,
});

export const entry = (fields = {}) => ({
  workflow: "Verify",
  event: "pull_request",
  sha: "a".repeat(40),
  runUrl: "https://github.com/o/r/actions/runs/5",
  startedAt: "2026-10-17T10:00:00Z",
  failed: [
    {
      name: "browser (webkit)",
      conclusion: "failure",
      url: "https://github.com/o/r/actions/runs/5/job/1",
    },
  ],
  ...fields,
});
