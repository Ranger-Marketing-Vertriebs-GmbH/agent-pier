// The live ticket topics, owner only. `tickets.project:<projectId>` is the value
// GET /api/tickets/projects/:projectId answers: the project's source links and its
// start records, without the remote ticket list (a REST read on open, on a source
// change and on Refresh). `tickets.connections` is the value GET /api/ticket-connections
// answers. TicketService signals both after every write of its own; a connection
// change also signals every project, whose view names the connection.

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

/** Signals the topic of `projectId` on `hub` (services.live, absent until it exists). */
export function ticketsProjectChanged(hub, projectId) {
  if (typeof projectId === "string") hub?.invalidate("tickets.project", projectId);
}

/** Signals the connections topic and every project topic on `hub`. */
export function ticketConnectionsChanged(hub) {
  hub?.invalidate("tickets.connections");
  hub?.invalidate("tickets.project");
}
