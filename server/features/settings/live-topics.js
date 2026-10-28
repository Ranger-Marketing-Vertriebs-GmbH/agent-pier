// The live `settings.summary` topic: the row statuses of the settings tabs, the value
// GET /api/settings/summary answers (local state only, no update check). Its sources
// (stores, the cached release check, the network config) announce no change, so the
// owner's successful writes signal it (live-wiring.js liveWriteSignals). Owner only.
// Live, only `operations.updates` is read (the menu's and the start page's update
// hint); the cached release check changes only through the awaited
// POST /operations/releases/check, so it is always pushed. Backup and diagnostic jobs
// that finish after their request answered, and MCP grants that expire, are not
// pushed until the next write: the settings tabs read the REST route themselves.
import { settingsSummary } from "./settings-summary.js";

/** The topic definition for LiveHub#define. */
export function settingsSummaryTopic(services) {
  return {
    name: "settings.summary",
    mode: "state",
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read: () => settingsSummary(services),
  };
}
