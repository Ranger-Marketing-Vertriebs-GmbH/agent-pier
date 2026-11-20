// How this AgentPier is reached, from the workspace state's `access`
// (server/features/sessions/workspace-state.js): only here, through the tailnet or
// the network, and how many other users may sign in. Without it, "local".
export function accessMode(state) {
  const access = state?.access;
  return {
    reach: access?.network ? "network" : access?.tailscale ? "tailscale" : "local",
    users: Number.isInteger(access?.users) && access.users > 0 ? access.users : 0,
  };
}
