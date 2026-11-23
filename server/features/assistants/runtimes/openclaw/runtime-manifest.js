// Official npm distribution integrity verified 2026-11-22 (OpenClaw 2026.11.6 and its
// search plugins); nodejs.org SHASUMS256 for Node 26.12.1 verified 2026-10-23 (signed
// by release key 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356).
export const runtimeManifest = {
  version: "2026.11.6",
  // The directly previous pin, the only version an activation may roll back to (see
  // the release qualification); the managed team plugin must stay compatible with it.
  rollbackTargets: ["2026.11.3"],
  nodeVersion: "26.12.1",
  npmVersion: "11.20.0",
  dependencyLockSha256:
    "9870a9aff36333b725eda1f4936dc6e73ee895a2b99f048d416b11a49c3a4b69",
  // Security fixes for transitive packages OpenClaw pins exactly, as npm `overrides`
  // in the locked package.json; the lock must resolve every copy to these versions.
  // Remove an entry once the pinned OpenClaw ships the fixed version itself (2026.11.6
  // ships zod 4.6.7, so the zod override is gone).
  dependencyOverrides: {},
  packageUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.11.6.tgz",
  packageIntegrity:
    "4MGjAMv8QlVrul3ZbCu8KjM7GhXfLdLzf0IrsO5QZ8LC3oYkduqs2rZiZpPDmTRpT6kXYke/OVaWrB+YmhBHLw==",
  // Official OpenClaw web search plugins (npm dist integrity, verified 2026-11-22).
  // They join the locked graph; a Gateway only loads one its configuration uses.
  searchPlugins: {
    duckduckgo: {
      id: "duckduckgo",
      package: "@openclaw/duckduckgo-plugin",
      version: "2026.11.6",
      integrity:
        "Q7FpnyV++qS6loE4mI+yEYg40Hla/R1ysS1ipaLYsDcZgDodw+1DVrukb0e3miKje5xbUcGHEioZmMc6Y/2XuA==",
    },
    perplexity: {
      id: "perplexity",
      package: "@openclaw/perplexity-plugin",
      version: "2026.11.6",
      integrity:
        "T7yMXABrF+GBX9CGAAFegmUeSUb3kQi3X267LkRnAK7xRw1ylElInDi4m8qoRVn8G+JVclyKg2EySr6TUMRzAg==",
    },
    brave: {
      id: "brave",
      package: "@openclaw/brave-plugin",
      version: "2026.11.6",
      integrity:
        "c7SgHOuhgqKn2o6tiPxCCBvIb4bW8OK4XI31Dy+ztrgHG624cxrsl0f5sa3tnPc2hTrJHYbwrqrJPUOPXBGaZQ==",
    },
  },
  nodeChecksums: {
    "darwin-arm64": "1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8",
    "darwin-x64": "b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff",
    "linux-arm64": "a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f",
    "linux-x64": "0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132",
  },
};
/**
 * Whether this AgentPier can run an OpenClaw version: the pin and its rollback
 * targets only (the managed team plugin refuses every other one). An installation
 * still on another version waits for the owner to activate the pin.
 */
export const runnableVersion = (version) =>
  version === runtimeManifest.version ||
  runtimeManifest.rollbackTargets.includes(version);
