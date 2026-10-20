import { splitSpecs, weigher } from "../browser-shards.mjs";

// Turns a selection into the job plan of .github/workflows/verify.yml. A pull
// request runs what its selection needs, on Linux unless the change is platform
// code; the merge queue (`full`) runs every node test and Chromium spec.

const linux = { os: "ubuntu-latest", node: 24 };
const macos = { os: "macos-latest", node: 24 };
const maxShards = 4;
// A Chromium shard job runs two Playwright processes (.github/actions/browser-shard):
// about 600 recorded seconds keep a shard near five minutes plus three of setup.
// Without recorded seconds, about 25 specs per shard.
const secondsPerShard = 600;
const specsPerShard = 25;
export const filesystemMatrix = [
  "tests/matrix/file-extract-platform.test.js",
  "tests/matrix/file-platform.test.js",
  "tests/matrix/file-recovery-boundary.test.js",
];
const nonoMatrix = "tests/matrix/nono-confinement.test.js";
const agentbusRuntimes = [
  "tests/unit/agentbus-queue.test.js",
  "tests/integration/agentbus-runtimes.test.js",
];

// The Chromium shard matrix: each shard's own specs, balanced by recorded seconds.
// Without timings a full run leaves every list empty, so each shard falls back to
// Playwright's --shard, and a selection is split by count.
export function browserShards(specs, { all, timings }) {
  if (!specs.length) return [];
  const count = all
    ? maxShards
    : Math.min(
        maxShards,
        timings
          ? Math.ceil(
              specs.map(weigher(timings)).reduce((a, b) => a + b, 0) / secondsPerShard,
            )
          : Math.ceil(specs.length / specsPerShard),
      );
  if (all && !timings)
    return Array.from({ length: count }, (_, index) => ({ shard: index + 1, specs: "" }));
  return splitSpecs(specs, count, timings || {})
    .filter((part) => part.specs.length)
    .map((part, index) => ({ shard: index + 1, specs: part.specs.join(" ") }));
}

export function ciPlan(
  result,
  { full = false, nodeTotal, browserSpecs = [], timings = null } = {},
) {
  if (full)
    return {
      full: true,
      mode: "all",
      "node-all": true,
      "node-tests": "",
      "browser-shards": browserShards(browserSpecs, { all: true, timings }),
      backend: [linux, macos],
      "filesystem-os": ["ubuntu-latest"],
      nono: true,
      "agentbus-runtimes": true,
    };
  const nodeAll = result.mode === "all" || result.node.length === nodeTotal;
  const browserAll =
    result.mode === "all" || result.browser.length === browserSpecs.length;
  const runs = (file) => nodeAll || result.node.includes(file);
  const testsNode = nodeAll || result.node.length > 0;
  return {
    full: false,
    mode: result.mode,
    "node-all": nodeAll,
    "node-tests": nodeAll ? "" : result.node.join(" "),
    "browser-shards": browserShards(browserAll ? browserSpecs : result.browser, {
      all: browserAll,
      timings,
    }),
    // A macOS backend only for platform code that some test exercises.
    backend: result.macos && testsNode ? [linux, macos] : [linux],
    "filesystem-os": filesystemMatrix.some(runs)
      ? ["ubuntu-latest", ...(result.macos ? ["macos-latest"] : [])]
      : [],
    nono: runs(nonoMatrix),
    "agentbus-runtimes": agentbusRuntimes.some(runs),
  };
}

// GITHUB_OUTPUT lines: strings as they are, everything else as JSON.
export function githubOutput(plan) {
  return Object.entries(plan)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join("\n");
}
