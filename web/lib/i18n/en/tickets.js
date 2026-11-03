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

// By `TicketSourceError` code: a source's list error and a failed write-back. The
// start refusals (already started, being started) arrive as translated server messages.
export const ticketErrorCopy = {
  unauthorized: "The ticket source rejected the credentials. Please check the API key.",
  forbidden: "The API key has no permission for this.",
  notFound: "The ticket source did not find the request.",
  rateLimited: "The ticket source is limiting requests right now. Try again later.",
  unavailable: "The ticket source is currently unavailable.",
  unreachable: "The ticket source cannot be reached.",
  invalidResponse: "The ticket source returned an unexpected response.",
  notConnected: "The ticket source is not connected for this project.",
};

// The Tickets tab of a project: its sources, the ticket list and the row actions.
export const projectTicketsCopy = {
  sources: "Ticket sources",
  github: "GitHub",
  plane: "Plane",
  githubConnected: (repo, credential, label) =>
    `${repo} · ${credential} · marks started issues with "${label}"`,
  githubNotConnected:
    "Not connected. Issues need a GitHub remote and a GitHub connection for its host.",
  planeConnected: (identifier, name, connection) =>
    [`${identifier} · ${name}`, connection].filter(Boolean).join(" · "),
  planeUnavailable: (identifier, name) =>
    `${identifier} · ${name} · the Plane connection is unavailable`,
  planeNotConnected: "Connect a Plane project",
  edit: "Edit",
  editTitle: "Edit ticket sources",
  connection: "Plane connection",
  chooseConnection: "Choose a connection",
  noConnections: "There is no Plane connection yet.",
  planeProject: "Plane project",
  choosePlaneProject: "Choose a project",
  loadingPlaneProjects: "Loading Plane projects …",
  startedState: "In progress state",
  startedStateAuto: "Plane's first started state",
  startedStateHelp: "The state a work item moves to when it starts.",
  githubLabel: "GitHub label for started issues",
  githubLabelHelp: "Added to an issue when it starts. GitHub creates a missing label.",
  disconnect: "Disconnect Plane project",
  label: "Label",
  allLabels: "All labels",
  searchLabels: "Search labels",
  source: "Source",
  allSources: "All",
  loading: "Loading tickets …",
  loadFailed: "The ticket sources of this project could not be loaded.",
  sourceError: (source, message) => `${source}: ${message}`,
  list: "Tickets",
  noTickets: "No open tickets.",
  noMatches: "No open ticket has this label.",
  noSources: "No ticket source connected",
  noSourcesBody:
    "Connect GitHub for the issues of this repository, or link a Plane project for its work items.",
  githubReference: "GitHub connections",
  githubReferenceSub: "Issues need a GitHub connection for the host of the repository.",
  planeReference: "Ticket sources",
  planeReferenceSub: "Plane connections for work items.",
  started: "Started",
  writeBackFailed: "Write-back failed",
  writeBackDetail: (message) => `Started, but not marked in progress: ${message}`,
  rowActions: (key) => `Actions for ${key}`,
  startSession: "Start session",
  startRun: "Start pipeline run",
  openIn: (source) => `Open in ${source}`,
  openSession: "Open session",
  openRun: "Open pipeline run",
  againTitle: (key) => `Start ${key} again?`,
  againBody:
    "This ticket was already started. Starting it again creates another session or run and marks the ticket once more.",
  again: "Start again",
};

// The session and run dialogs when they start a ticket.
export const ticketStartCopy = {
  sessionTitle: (key) => `Start ${key} as a session`,
  runTitle: (key) => `Start ${key} as a pipeline run`,
  sessionDescription: (title) =>
    `The session starts in the project folder with the ticket "${title}" as its task.`,
  runDescription: (title) =>
    `The run starts in the project folder with the ticket "${title}" as its task.`,
  again: "Start again",
};
