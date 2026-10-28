// The live `job.plugins:<accountId>` topic, owner only, a kind of the `job.<kind>`
// family (live/job-topics.js): a CLI account's plugins, the value
// GET /accounts/:id/plugins answers without a catalog account (the installed
// plugins, the catalog, the marketplaces and `busy` while a plugin change runs).
// PluginStore signals the start and the end of every change; both happen in this
// process, so the topic is not sampled. A change ends with `busy` gone, so its end
// is always pushed. An account shares its plugins with the profile it resolves to,
// so every account's topic is signalled. A read while nothing runs asks the CLI
// again, so the page follows the topic only while a change runs elsewhere.

// Account ids (UUIDs, `local-codex`).
const ACCOUNT_ID = /[A-Za-z0-9][A-Za-z0-9_-]{0,119}/;

/** A plugin change started or ended: signals every account's topic on `hub`. */
export function pluginJobChanged(hub) {
  hub?.invalidate("job.plugins");
}

/** The `job.plugins` options for defineJobTopic (live/job-topics.js). */
export function pluginsJob(services) {
  return {
    kind: "plugins",
    param: ACCOUNT_ID,
    read: (id) => services.plugins.list(id),
  };
}
