// Ticket sources: the Plane connections under Connections, and the texts of the
// codes a ticket source or a ticket start answers with.
export const planeConnectionsCopy = {
  title: "Ticket sources",
  description:
    "Plane connections for the Tickets tab of a project. GitHub issues use the GitHub connections.",
  list: "Plane connections",
  add: "Add Plane connection",
  edit: "Edit Plane connection",
  remove: "Delete",
  editRow: "Edit",
  rowActions: (name) => `Actions for ${name}`,
  removeTitle: (name) => `Delete Plane connection "${name}"?`,
  removeConfirm: (name) =>
    `AgentPier forgets the connection "${name}" and its API key. Projects that still use it must be unlinked first.`,
  loadFailed: "The Plane connections could not be loaded.",
  name: "Name",
  namePlaceholder: "Plane at work",
  apiUrl: "API URL",
  apiUrlHelp:
    "https://api.plane.so for Plane Cloud, or the address of your own Plane. Only https:// (http:// only for localhost).",
  workspace: "Workspace slug",
  workspaceHelp: "The part after the address in your Plane URL, for example my-team.",
  apiKey: "API key",
  apiKeyKeep: "Saved. Leave blank to keep the key.",
  apiKeyPlaceholder: "Plane API key",
  apiKeyHelp:
    "Create it in Plane under Profile settings › Personal access tokens. It is stored on this computer and never shown again.",
};

// By `TicketSourceError` code, plus the start refusals.
export const ticketErrorCopy = {
  unauthorized: "The ticket source rejected the credentials. Please check the API key.",
  forbidden: "The API key has no permission for this.",
  notFound: "The ticket source did not find the request.",
  rateLimited: "The ticket source is limiting requests right now. Try again later.",
  unavailable: "The ticket source is currently unavailable.",
  unreachable: "The ticket source cannot be reached.",
  invalidResponse: "The ticket source returned an unexpected response.",
  notConnected: "The ticket source is not connected for this project.",
  alreadyStarted: "This ticket was already started. Confirm to start it again.",
  alreadyStarting: "This ticket is being started right now.",
  connectionInUse: "A project still uses this connection.",
};
