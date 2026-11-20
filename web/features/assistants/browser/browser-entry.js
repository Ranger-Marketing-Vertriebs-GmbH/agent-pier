// Where an agent's own browser can be opened from (docs/agents.md "Agent browser"):
// the chat header, ⌘K and an agent's take-over link in its chat.

/**
 * Whether the owner gets an entry to `agent`'s browser: while its browser capability
 * is on, for an agent that is not archived and has a browser profile of its own (not a
 * task-bound team member). A user's own agent is hers: the owner only watches it under
 * her opt-in, from its settings.
 */
export const browserOffered = (agent) =>
  Boolean(agent?.id) &&
  !agent.archivedAt &&
  (!agent.teamMemberId || agent.lifetime === "permanent") &&
  agent.userAccess?.mode !== "own" &&
  agent.capabilities?.browser === true;

/** The route of `id`'s browser page; `takeover` takes control once the picture is live. */
export const browserRoute = (id, { takeover = false } = {}) => ({
  view: "agents",
  assistantId: id,
  agentBrowser: true,
  ...(takeover ? { takeover: true } : {}),
});

// The link an agent writes into its chat to ask the owner to take over its browser
// (assistant-bootstrap.js): `[Take over my browser](agentpier:browser-takeover)`.
export const takeoverHref = "agentpier:browser-takeover";
