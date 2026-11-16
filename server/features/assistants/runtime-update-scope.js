import { ownProcess } from "./runtimes/runtime-for.js";

// AgentPier's shared agent workspace root (`<data>/assistants/workspaces/<id>`) holds
// the folders of OpenClaw and Hermes agents alike (hermes-paths.js hermesWorkspace).
// Each runtime's update journal (runtime-updates.js) snapshots and restores only its
// own agents' folders there (runtime-update-snapshot.js `scope`), so a rollback of
// one runtime never reverts, or removes, the other's agents' files.

// The ids of the Hermes agents `store` holds, archived and deleting ones included;
// none without a store (Hermes's journal then owns no folder of the shared root).
const ownProcessIds = (store) =>
  new Set(
    (store?.listAssistants() || []).filter(ownProcess).map((profile) => profile.id),
  );

/** OpenClaw's journal: every folder of `workspaces/` but a Hermes agent's. */
export function sharedHostUpdateScope(store) {
  const own = ownProcessIds(store);
  return { workspaces: (name) => !own.has(name) };
}

/** Hermes's journal: the Hermes agents' folders of the shared root. */
export function ownProcessUpdateScope(store) {
  const own = ownProcessIds(store);
  return { agentWorkspaces: (name) => own.has(name) };
}
