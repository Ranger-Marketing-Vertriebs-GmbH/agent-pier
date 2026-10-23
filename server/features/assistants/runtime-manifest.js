// Official npm distribution integrity verified 2026-10-14 (OpenClaw 2026.10.3 and its
// search plugins); nodejs.org SHASUMS256 for Node 26.12.1 verified 2026-10-23 (signed
// by release key 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356).
export const runtimeManifest = {
  version: "2026.10.3",
  // Qualified predecessors an activation may roll back to (see the release
  // qualification); the managed team plugin must stay compatible with each.
  rollbackTargets: ["2026.9.9", "2026.9.8"],
  nodeVersion: "26.12.1",
  npmVersion: "11.20.0",
  dependencyLockSha256:
    "5d0ace4d722aa7800e8f11ff8a84f274e0aef3ad781158b8ed54c81e0774bbd2",
  packageUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.10.3.tgz",
  packageIntegrity:
    "ncl6LntMlf76K39LFhVrDXQTbaGNAG5j52f7PL5P8vIn0knWmCrvfAe9DHMslFq+47HeOWBH2CBYQH8zEb+UAA==",
  // Official OpenClaw web search plugins (npm dist integrity, verified 2026-10-14).
  // They join the locked graph; a Gateway only loads one its configuration uses.
  searchPlugins: {
    duckduckgo: {
      id: "duckduckgo",
      package: "@openclaw/duckduckgo-plugin",
      version: "2026.10.3",
      integrity:
        "qFsIhptLSywvxyhXf2Gd9jCu5LxhNc74FLcCn5JbIw1zcBd50RF4PcsNajYEU2UsKnMzZS6iye5QMkhMRh1PzA==",
    },
    perplexity: {
      id: "perplexity",
      package: "@openclaw/perplexity-plugin",
      version: "2026.10.3",
      integrity:
        "JgGEvG41QNiuNLRhKfQr+S6hPxypQyQYGfKNcfo4bWxhncXm2quulsy75kzuzC7uMNvdwKZPUg/q5yLsMWsi2A==",
    },
    brave: {
      id: "brave",
      package: "@openclaw/brave-plugin",
      version: "2026.10.3",
      integrity:
        "eBzYZeHH3YB/uqscKR/ylrM99TGy5q2YZNB2my0Y1+C0CJMtvQbjUOL1ao1uPwC1jvu5Dzbjz/QyjK+daODErQ==",
    },
  },
  nodeChecksums: {
    "darwin-arm64": "1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8",
    "darwin-x64": "b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff",
    "linux-arm64": "a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f",
    "linux-x64": "0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132",
  },
};
