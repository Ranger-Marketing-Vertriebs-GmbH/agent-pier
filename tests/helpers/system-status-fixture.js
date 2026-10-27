// Start page system status answers for browser fixtures that refuse unknown requests.
const GB = 1024 ** 3;
export function summary({ freePercent = 40, diskLow = false } = {}) {
  return {
    sampledAt: new Date().toISOString(),
    cpu: { percent: 34, cores: 12, load: [4.68, 5.61, 6.17] },
    memory: { totalBytes: 48 * GB, usedBytes: 36 * GB, percent: 75 },
    disk: {
      totalBytes: 500 * GB,
      freeBytes: 5 * freePercent * GB,
      usedBytes: (500 - 5 * freePercent) * GB,
      freePercent,
    },
    agentPier: { cpuPercent: 2.5, rssBytes: 3 * GB },
    warning: { diskLow, thresholdPercent: 10 },
  };
}
export function details(options) {
  const now = Date.now();
  return {
    ...summary(options),
    host: { platform: "darwin" },
    processes: [
      { kind: "server", processes: 3, rssBytes: 0.2 * GB, cpuPercent: 0.4 },
      { kind: "gateway", processes: 2, rssBytes: 0.8 * GB, cpuPercent: 1.1 },
      {
        kind: "session",
        id: "s1",
        name: "Fix the login flow",
        tool: "claude",
        project: "agent-pier",
        processes: 4,
        rssBytes: 2 * GB,
        cpuPercent: 1,
      },
      {
        kind: "session",
        id: "s2",
        name: "Kanji quiz",
        tool: "codex",
        project: "japanese",
        processes: 3,
        rssBytes: 0.3 * GB,
        cpuPercent: 1.6,
      },
      {
        kind: "session",
        id: "s3",
        name: "Shell",
        tool: "shell",
        project: "",
        processes: 1,
        rssBytes: 0.01 * GB,
        cpuPercent: 0,
      },
    ],
    // Two runs a 10-minute gap apart: nobody looked meanwhile.
    history: [
      ...Array.from({ length: 10 }, (_, index) => ({
        t: now - 20 * 60_000 - (9 - index) * 60_000,
        cpu: 10 + index,
        memory: 60,
        agentCpu: 1,
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        t: now - (19 - index) * 30_000,
        cpu: 20 + index,
        memory: 70 + index / 4,
        agentCpu: 2,
      })),
    ],
    areas: {
      state: "ready",
      computedAt: new Date(now - 60_000).toISOString(),
      partial: false,
      totalBytes: 15 * GB,
      areas: [
        { id: "profiles", bytes: 12 * GB },
        { id: "clis", bytes: GB },
        { id: "backups", bytes: 0.6 * GB },
        { id: "agentWorkspaces", bytes: 0.5 * GB },
        { id: "tools", bytes: 0.4 * GB },
        { id: "runtimes", bytes: 0.3 * GB },
        { id: "chatAttachments", bytes: 0.2 * GB },
        { id: "agentAttachments", bytes: 0.1 * GB },
        { id: "logs", bytes: 0.05 * GB },
        { id: "other", bytes: 0.9 * GB },
      ],
    },
  };
}

/** GET /system-status/cleanup/summary: `state` "pending" has no sizes yet. */
export function cleanupSummary(state = "ready") {
  if (state === "pending") return { state };
  return {
    state,
    computedAt: new Date(Date.now() - 30_000).toISOString(),
    groups: {
      updateBackups: {
        bytes: 0.5 * GB,
        count: 2,
        blocked: false,
        atLeast: false,
        oldestAt: "2026-09-01T10:00:00.000Z",
      },
      transcripts: { bytes: 2 * GB, count: 41, olderThanDays: 90, profiles: 2 },
      dependencies: { bytes: 0.25 * GB, count: 4, agents: 2, atLeast: true },
    },
  };
}

/** The answer for a system status API path, or undefined for any other path. */
export function systemStatusAnswer(path) {
  if (path === "/api/system-status") return summary();
  if (path === "/api/system-status/details") return details();
  if (path === "/api/system-status/cleanup/summary") return cleanupSummary();
}
