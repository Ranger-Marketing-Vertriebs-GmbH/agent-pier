// Official npm distribution integrity verified 2026-10-30 (OpenClaw 2026.10.9 and its
// search plugins); nodejs.org SHASUMS256 for Node 26.12.1 verified 2026-10-23 (signed
// by release key 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356).
export const runtimeManifest = {
  version: "2026.10.9",
  // Qualified predecessors an activation may roll back to (see the release
  // qualification); the managed team plugin must stay compatible with each.
  rollbackTargets: ["2026.10.7", "2026.10.3", "2026.9.9", "2026.9.8"],
  nodeVersion: "26.12.1",
  npmVersion: "11.20.0",
  dependencyLockSha256:
    "c4e4b69d557d20c0a181116c92a811b8a0a894fb4a964801b76ff0f468c21670",
  // Security fixes for transitive packages OpenClaw pins exactly (it ships undici
  // 8.11.2 and zod 4.6.5, both with published advisories). npm `overrides` in the
  // locked package.json; the lock must resolve every copy to these versions. Remove
  // an entry once the pinned OpenClaw ships the fixed version itself.
  dependencyOverrides: { undici: "8.12.3", zod: "4.6.7" },
  packageUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.10.9.tgz",
  packageIntegrity:
    "KbIl0/7an0/nKBo92FnJg7LFcEpFVQyOgSRfHNE9yxELg1Ebql7BmBsdLL+1dDOLZnQtuwjt6Hy45CCrmYdJNA==",
  // Official OpenClaw web search plugins (npm dist integrity, verified 2026-10-30).
  // They join the locked graph; a Gateway only loads one its configuration uses.
  searchPlugins: {
    duckduckgo: {
      id: "duckduckgo",
      package: "@openclaw/duckduckgo-plugin",
      version: "2026.10.9",
      integrity:
        "ysdTDjQmP3x8oemf1uPCm3ZCCkXcRsdOe0KJipu5lERE1PKIwLqVut3ai6RCUoPP1m945Qf4RjUuxHDaNgOFTA==",
    },
    perplexity: {
      id: "perplexity",
      package: "@openclaw/perplexity-plugin",
      version: "2026.10.9",
      integrity:
        "fs2CUCfPJTcpLxNuHfhUZ/MOgSgFKREUECMsxwqFQ97Y4DTSoY/wSi8g3HBwHJaAiBASe2ckPgD1Qe8s8eP1pw==",
    },
    brave: {
      id: "brave",
      package: "@openclaw/brave-plugin",
      version: "2026.10.9",
      integrity:
        "F7CKF0Vtd+YrGWRFxhnB2Y1bRRDXfksE/5IcBCMw9gWRiGmzAM72sHxHaP0mPNQ8sg3gEDJ0yZSdUCV4+qPVrg==",
    },
  },
  nodeChecksums: {
    "darwin-arm64": "1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8",
    "darwin-x64": "b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff",
    "linux-arm64": "a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f",
    "linux-x64": "0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132",
  },
};
