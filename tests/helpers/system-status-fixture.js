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
    processes: [
      { kind: "server", processes: 3, rssBytes: 0.2 * GB, cpuPercent: 0.4 },
      { kind: "gateway", processes: 2, rssBytes: 0.8 * GB, cpuPercent: 1.1 },
      {
        kind: "session",
        id: "s1",
        name: "Fix the login flow",
        tool: "claude",
        processes: 4,
        rssBytes: 2 * GB,
        cpuPercent: 1,
      },
    ],
    history: Array.from({ length: 20 }, (_, index) => ({
      t: now - (19 - index) * 30_000,
      cpu: 20 + index,
      memory: 70 + index / 4,
      agentCpu: 2,
    })),
    areas: {
      state: "ready",
      computedAt: new Date(now - 60_000).toISOString(),
      partial: false,
      totalBytes: 15 * GB,
      areas: [
        { id: "profiles", bytes: 12 * GB },
        { id: "clis", bytes: GB },
        { id: "agentAttachments", bytes: 0.1 * GB },
        { id: "other", bytes: 0.9 * GB },
      ],
    },
  };
}

/** The answer for a system status API path, or undefined for any other path. */
export function systemStatusAnswer(path) {
  if (path === "/api/system-status") return summary();
  if (path === "/api/system-status/details") return details();
}
