// Official npm distribution integrity and nodejs.org SHASUMS256, verified 2026-10-07;
// dependency lock extended with the search plugins 2026-10-11.
export const runtimeManifest = {
  version: "2026.9.8",
  // Qualified predecessors an activation may roll back to (see the release
  // qualification); the managed team plugin must stay compatible with each.
  rollbackTargets: ["2026.9.7"],
  nodeVersion: "26.7.0",
  npmVersion: "11.19.0",
  dependencyLockSha256:
    "563cf3904093b49428854c6462500f0852cc5ca8171a76f733195f2f047afef8",
  packageUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.9.8.tgz",
  packageIntegrity:
    "G+JkNUhtpDE3cXR4AEi2NyyG9fqI/T2WUSl8ZnR8AATH8Dh1kC3qYFL7wwPoZtgHiP/cszA86PEiE0PDysxb9Q==",
  // Official OpenClaw web search plugins (npm dist integrity, verified 2026-10-11).
  // They join the locked graph; a Gateway only loads one its configuration uses.
  searchPlugins: {
    duckduckgo: {
      id: "duckduckgo",
      package: "@openclaw/duckduckgo-plugin",
      version: "2026.9.8",
      integrity:
        "FaKJI2E7cDb1IEu9iVKbJBdPz8pO2mmwLyiwiNm6scBwyXhObodwHe+Y1B3CcyQ+QHhwjM9UM4Pq1fquo2WUsw==",
    },
    perplexity: {
      id: "perplexity",
      package: "@openclaw/perplexity-plugin",
      version: "2026.9.8",
      integrity:
        "cIMgxl7QAnjdTS0djIcrZM65cRXVwLE/M8W59T7AvhjPh5B5LeYuHGRCd46AC6o0R0aIa8/prTPEkDl1yMYnDw==",
    },
    brave: {
      id: "brave",
      package: "@openclaw/brave-plugin",
      version: "2026.9.8",
      integrity:
        "QHG1EGYN52uv9ayhNGRobql3M1ojqohc36Fa/U+UpYK2bR6BndueWWHdgNcsbsF+nkg++/AKJLf/elethqhJKQ==",
    },
  },
  nodeChecksums: {
    "darwin-arm64": "7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4",
    "darwin-x64": "f279d1ed28ce57f7788bf23435d2ad7fdd7438904ad5c4d8a1081a7cde3d4b96",
    "linux-arm64": "925aa6157dd37542d0d7f2e28b7bf61e7b39284411210b0498bc3788db4aef68",
    "linux-x64": "bd6b6c31e377bad9ad579bed72e5bc11f4c879ac9452ad51d30e646ea3d828df",
  },
};
