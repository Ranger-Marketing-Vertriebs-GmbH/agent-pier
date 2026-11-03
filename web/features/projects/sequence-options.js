import { launchAccesses } from "../sessions/useLaunchAccess.js";

/**
 * Saved session settings (a rule's `options.session`, the queue view's
 * `defaults.repair`) as the launch-access hook's starting choice; null unless its CLI
 * is installed and its account or connection is still there for that CLI.
 */
export function launchStart(state, saved) {
  if (!saved?.tool) return null;
  if (!state.tools.some((tool) => tool.id === saved.tool && tool.installed)) return null;
  const { accounts, connections } = launchAccesses(state, saved.tool);
  const known = saved.providerConnectionId
    ? connections.some((connection) => connection.id === saved.providerConnectionId)
    : accounts.some((account) => account.id === saved.accountId);
  if (!known) return null;
  return {
    config: {
      providerConnectionId: saved.providerConnectionId,
      accountId: saved.accountId,
      models: { default: saved.providerModelId || saved.nativeModelId || "" },
    },
  };
}
