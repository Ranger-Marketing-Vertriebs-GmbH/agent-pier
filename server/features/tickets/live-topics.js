// The live ticket topics, owner only. `tickets.project:<projectId>` is the value
// GET /api/tickets/projects/:projectId answers: the project's source links and its
// start records, without the remote ticket list (a REST read on open, on a source
// change and on Refresh). `tickets.connections` is the value GET /api/ticket-connections
// answers. TicketService signals both after every write of its own; a connection
// change also signals every project, whose view names the connection.
// `tickets.queue:<projectId>` is the value GET /api/tickets/projects/:projectId/queue
// answers: the project's ticket sequence. The sequence store signals it after every
// saved change, whoever wrote it (the engine, an owner action, a rule).
// `tickets.rules:<projectId>` is the value GET /api/tickets/projects/:projectId/rules
// answers: the project's label rules with their poll status. The rule store signals it
// after every saved change: an owner edit, a pass's status write, a pickup.

const PROJECT_PARAM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const owner = (principal) => principal?.role === "owner";

/** The `tickets.project` topic definition for LiveHub#define. */
export function ticketsProjectTopic(services) {
  return {
    name: "tickets.project",
    mode: "state",
    param: PROJECT_PARAM,
    authorize: owner,
    scopeKey: () => "owner",
    read: (_principal, projectId) => services.tickets.projectView(projectId),
  };
}

/** The `tickets.connections` topic definition for LiveHub#define. */
export function ticketConnectionsTopic(services) {
  return {
    name: "tickets.connections",
    mode: "state",
    authorize: owner,
    scopeKey: () => "owner",
    read: () => services.tickets.connectionsView(),
  };
}

/** The `tickets.queue` topic definition for LiveHub#define. */
export function ticketsQueueTopic(services) {
  return {
    name: "tickets.queue",
    mode: "state",
    param: PROJECT_PARAM,
    authorize: owner,
    scopeKey: () => "owner",
    read: (_principal, projectId) => services.ticketSequences.view(projectId),
  };
}

/** The `tickets.rules` topic definition for LiveHub#define. */
export function ticketRulesTopic(services) {
  return {
    name: "tickets.rules",
    mode: "state",
    param: PROJECT_PARAM,
    authorize: owner,
    scopeKey: () => "owner",
    read: (_principal, projectId) => services.ticketRules.view(projectId),
  };
}

/** Signals the topic of `projectId` on `hub` (services.live, absent until it exists). */
export function ticketsProjectChanged(hub, projectId) {
  if (typeof projectId === "string") hub?.invalidate("tickets.project", projectId);
}

/** Signals the connections topic and every project topic on `hub`. */
export function ticketConnectionsChanged(hub) {
  hub?.invalidate("tickets.connections");
  hub?.invalidate("tickets.project");
}

/** Signals the ticket sequence queue topic of `projectId` on `hub`. */
export function ticketQueueChanged(hub, projectId) {
  if (typeof projectId === "string") hub?.invalidate("tickets.queue", projectId);
}

/** Signals the label rules topic of `projectId` on `hub`. */
export function ticketRulesChanged(hub, projectId) {
  if (typeof projectId === "string") hub?.invalidate("tickets.rules", projectId);
}
