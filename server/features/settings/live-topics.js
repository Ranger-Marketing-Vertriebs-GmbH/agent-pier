// The live `settings.summary` topic: the row statuses of the settings tabs, the value
// GET /api/settings/summary answers (local state only, no update check). Its sources
// (stores, the cached release check, the network config) announce no change, so the
// owner's successful writes signal it (live-wiring.js liveWriteSignals). Owner only.
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
