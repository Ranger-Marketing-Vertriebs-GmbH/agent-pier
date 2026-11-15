// Official npm distribution integrity verified 2026-11-15 (OpenClaw 2026.11.3 and its
// search plugins); nodejs.org SHASUMS256 for Node 26.12.1 verified 2026-10-23 (signed
// by release key 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356).
export const runtimeManifest = {
  version: "2026.11.3",
  // Qualified predecessors an activation may roll back to (see the release
  // qualification); the managed team plugin must stay compatible with each.
  rollbackTargets: ["2026.10.9", "2026.10.7", "2026.10.3", "2026.9.9", "2026.9.8"],
  nodeVersion: "26.12.1",
  npmVersion: "11.20.0",
  dependencyLockSha256:
    "b6416c1203e6f0d6be5dedca1619dcf4f6d946e943d5bea3cec18ff7bfbf0487",
  // Security fixes for transitive packages OpenClaw pins exactly (it ships zod
  // 4.6.5, which has a published advisory). npm `overrides` in the locked
  // package.json; the lock must resolve every copy to these versions. Remove an
  // entry once the pinned OpenClaw ships the fixed version itself.
  dependencyOverrides: { zod: "4.6.7" },
  packageUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.11.3.tgz",
  packageIntegrity:
    "FBq/q0TCaoA2b7qfdV0q81fHhI6RBB1zAQfJQREc1u2TlK5khVgCUsAlXskLWthyVqRz5PWEj+oOmfYgK58dHg==",
  // Official OpenClaw web search plugins (npm dist integrity, verified 2026-11-15).
  // They join the locked graph; a Gateway only loads one its configuration uses.
  searchPlugins: {
    duckduckgo: {
      id: "duckduckgo",
      package: "@openclaw/duckduckgo-plugin",
      version: "2026.11.3",
      integrity:
        "i3n1GUiYZlswLt5InMg5z+BRSEcgRcKa3ER109712vF8PdRZpV+7txHALbgoLzfYr7BXhTKyYxiabYWFmubcPA==",
    },
    perplexity: {
      id: "perplexity",
      package: "@openclaw/perplexity-plugin",
      version: "2026.11.3",
      integrity:
        "eWul9XxwcxfgMXHJ0WGX6mgZ+6bn6bixUUYlGaaUoxh3PVVxmBFt5fnNaIagBRM/30nBLiDDccAD8hCDtsCl8A==",
    },
    brave: {
      id: "brave",
      package: "@openclaw/brave-plugin",
      version: "2026.11.3",
      integrity:
        "eCJsaQRAa1lfNNwkOYEG7of/rP6wHHXRZnUnrE4R49ZWepevtSgeyD3nQw7834jtGMhLfLPyRFyC1TcvAwVwuQ==",
    },
  },
  nodeChecksums: {
    "darwin-arm64": "1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8",
    "darwin-x64": "b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff",
    "linux-arm64": "a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f",
    "linux-x64": "0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132",
  },
};
