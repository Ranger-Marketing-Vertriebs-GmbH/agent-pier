// Official npm distribution integrity verified 2026-10-14 (OpenClaw 2026.9.9 and its
// search plugins); nodejs.org SHASUMS256 verified 2026-10-07.
export const runtimeManifest = {
  version: "2026.9.9",
  // Qualified predecessors an activation may roll back to (see the release
  // qualification); the managed team plugin must stay compatible with each.
  rollbackTargets: ["2026.9.8", "2026.9.7"],
  nodeVersion: "26.7.0",
  npmVersion: "11.19.0",
  dependencyLockSha256:
    "c197993dfd41721ca4917033ecde633551cb325611539e1439ea0711e24c3545",
  packageUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.9.9.tgz",
  packageIntegrity:
    "3sB6ejq5smBozfBhVEDfK48wFpbkx+0f6PJ19qZjC3ab3RoFrYO58CnE2mAsbUy8sXdxdBtjQ3vkAqcW9BZXAw==",
  // Official OpenClaw web search plugins (npm dist integrity, verified 2026-10-14).
  // They join the locked graph; a Gateway only loads one its configuration uses.
  searchPlugins: {
    duckduckgo: {
      id: "duckduckgo",
      package: "@openclaw/duckduckgo-plugin",
      version: "2026.9.9",
      integrity:
        "KbbF4te7gsS+WsUtg4ihrxnMI2i8zhtTf+8HaBjEOwCyd8aC8sEIJx7sKkiqk4s3FUq2rAjs9vdx4JB2W5JpJg==",
    },
    perplexity: {
      id: "perplexity",
      package: "@openclaw/perplexity-plugin",
      version: "2026.9.9",
      integrity:
        "JRnGCkPGT7FOXgmn9zI88BtU6oIZB945egsgLZapjIiWZYyA1zQ32/jHVOfvaigwexddqGGLsPJSYCV8rtrdcg==",
    },
    brave: {
      id: "brave",
      package: "@openclaw/brave-plugin",
      version: "2026.9.9",
      integrity:
        "Zk6xMf+pP4gMCK0Lw0okDM5MVprJgHNkbzsxj8dXRI9TH3MU2GrDkXYGi99wNR78putj//ENjndHGoZbuuh/DA==",
    },
  },
  nodeChecksums: {
    "darwin-arm64": "7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4",
    "darwin-x64": "f279d1ed28ce57f7788bf23435d2ad7fdd7438904ad5c4d8a1081a7cde3d4b96",
    "linux-arm64": "925aa6157dd37542d0d7f2e28b7bf61e7b39284411210b0498bc3788db4aef68",
    "linux-x64": "bd6b6c31e377bad9ad579bed72e5bc11f4c879ac9452ad51d30e646ea3d828df",
  },
};
