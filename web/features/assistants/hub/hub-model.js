// Pure rules of the agents hub's states and links (handoff 5.2, 5.10).

/** The activation phase while agents come up, or null once nothing is pending. */
export function activationPhase({ saving, enabled, availability }) {
  if (saving) return "switching";
  if (!enabled) return null;
  if (availability === "installing") return "installing";
  if (availability === "starting") return "starting";
  return null;
}

/** The service is down: neither starting nor running (`failed` or stopped). */
export const serviceDown = (runtime) =>
  ["disabled", "failed"].includes(runtime?.availability);

/** "Persönlichen Agenten anlegen": the new agent wizard with this entry. */
export const templateAgentRoute = (entry) => ({
  view: "agents",
  creating: true,
  template: { id: entry.id, revision: entry.revision },
});

/**
 * "Als Unteragent in CLI installieren …": Coding › CLIs & Erweiterungen ›
 * Unteragenten with the entry preselected (`install=<entry id>`); the install flow
 * for a chosen CLI profile lives there.
 */
export const subagentInstallRoute = (entry) => ({
  view: "coding",
  codingTab: "extensions",
  profileId: "",
  extensionTab: "subagents",
  install: entry.id,
});
