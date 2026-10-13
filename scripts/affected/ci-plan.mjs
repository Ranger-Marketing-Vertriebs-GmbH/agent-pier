// Turns a selection into the job plan of .github/workflows/verify.yml. A pull
// request runs what its selection needs, on Linux unless the change is platform
// code; the merge queue (`full`) runs every suite.

const linux = { os: "ubuntu-latest", node: 24 };
const macos = { os: "macos-latest", node: 24 };
const maxShards = 4;
// About 25 specs keep a shard near five minutes, plus about three of setup.
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

const range = (count) => Array.from({ length: count }, (_, index) => index + 1);

export function ciPlan(result, { full = false, nodeTotal, browserTotal } = {}) {
  if (full)
    return {
      full: true,
      mode: "all",
      "node-all": true,
      "node-tests": "",
      "browser-tests": "",
      "browser-shards": range(maxShards),
      backend: [linux, macos],
      "filesystem-os": ["ubuntu-latest"],
      nono: true,
      "agentbus-runtimes": true,
    };
  const nodeAll = result.mode === "all" || result.node.length === nodeTotal;
  const browserAll = result.mode === "all" || result.browser.length === browserTotal;
  const runs = (file) => nodeAll || result.node.includes(file);
  const shards = browserAll
    ? maxShards
    : Math.min(maxShards, Math.ceil(result.browser.length / specsPerShard));
  const testsNode = nodeAll || result.node.length > 0;
  return {
    full: false,
    mode: result.mode,
    "node-all": nodeAll,
    "node-tests": nodeAll ? "" : result.node.join(" "),
    "browser-tests": browserAll ? "" : result.browser.join(" "),
    "browser-shards": range(shards),
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
