// Official npm distribution integrity verified 2026-11-09 (OpenClaw 2026.11.2 and its
// search plugins); nodejs.org SHASUMS256 for Node 26.12.1 verified 2026-10-23 (signed
// by release key 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356).
export const runtimeManifest = {
  version: "2026.11.2",
  // Qualified predecessors an activation may roll back to (see the release
  // qualification); the managed team plugin must stay compatible with each.
  rollbackTargets: ["2026.10.9", "2026.10.7", "2026.10.3", "2026.9.9", "2026.9.8"],
  nodeVersion: "26.12.1",
  npmVersion: "11.20.0",
  dependencyLockSha256:
    "2cadd51b4b78f88d571ffa7d6d6cf1393f1b345e12f19cdc3f308500c7778258",
  // Security fixes for transitive packages OpenClaw pins exactly (it ships zod
  // 4.6.5, which has a published advisory). npm `overrides` in the locked
  // package.json; the lock must resolve every copy to these versions. Remove an
  // entry once the pinned OpenClaw ships the fixed version itself.
  dependencyOverrides: { zod: "4.6.7" },
  packageUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.11.2.tgz",
  packageIntegrity:
    "SgBml4WLp8V1DdAYkrTPLzVdA/iYo3iuHCtm4788GjaG83QZdd1VeOTlue0HBJGdn3SbFE06b6uPs+AM5ShMgg==",
  // Official OpenClaw web search plugins (npm dist integrity, verified 2026-11-09).
  // They join the locked graph; a Gateway only loads one its configuration uses.
  searchPlugins: {
    duckduckgo: {
      id: "duckduckgo",
      package: "@openclaw/duckduckgo-plugin",
      version: "2026.11.2",
      integrity:
        "lACLSRwQ2lbMA6KnRaYu1UKwppOmWEGX/EZslNpTiVRVQ64aKyRnN2k72kAAWJwrcznAOrVOHMCkxaWXBhgQBg==",
    },
    perplexity: {
      id: "perplexity",
      package: "@openclaw/perplexity-plugin",
      version: "2026.11.2",
      integrity:
        "Iql1KxzQJPyrxWof+ZXIgAbXZ4vR6P9CznnzOhwOghIqw/TBCs4ojVwptTbcI2xj7JxQAf0AUesJVMI0R0+1XQ==",
    },
    brave: {
      id: "brave",
      package: "@openclaw/brave-plugin",
      version: "2026.11.2",
      integrity:
        "9aOzDUDyOAHg8NuBo1ugbRiYkMP7M35LDo1yCjxgel+o6iyVep1dmxhejxnAbM4cqmWpw+rRA4UKDN0uS0YjzQ==",
    },
  },
  nodeChecksums: {
    "darwin-arm64": "1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8",
    "darwin-x64": "b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff",
    "linux-arm64": "a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f",
    "linux-x64": "0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132",
  },
};
