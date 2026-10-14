// Official npm distribution integrity verified 2026-10-14 (OpenClaw 2026.10.3 and its
// search plugins); nodejs.org SHASUMS256 verified 2026-10-07.
export const runtimeManifest = {
  version: "2026.10.3",
  // Qualified predecessors an activation may roll back to (see the release
  // qualification); the managed team plugin must stay compatible with each.
  rollbackTargets: ["2026.9.9", "2026.9.8"],
  nodeVersion: "26.7.0",
  npmVersion: "11.19.0",
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
    "darwin-arm64": "7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4",
    "darwin-x64": "f279d1ed28ce57f7788bf23435d2ad7fdd7438904ad5c4d8a1081a7cde3d4b96",
    "linux-arm64": "925aa6157dd37542d0d7f2e28b7bf61e7b39284411210b0498bc3788db4aef68",
    "linux-x64": "bd6b6c31e377bad9ad579bed72e5bc11f4c879ac9452ad51d30e646ea3d828df",
  },
};
