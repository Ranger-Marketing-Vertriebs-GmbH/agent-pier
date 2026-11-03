/** English messages of the ticket sources (GitHub issues, Plane work items). */
export const tickets = Object.freeze({
  connectionNotFound: "The ticket source connection was not found.",
  connectionInUse: "A project still uses this connection.",
  invalidBaseUrl:
    "The ticket source address must start with https:// (http:// only for localhost) and must not contain credentials, a query or a fragment.",
  invalidWorkspace: "The workspace slug of the ticket source is invalid.",
  invalidToken: "The ticket source token is invalid.",
  tokenRequired: "A token is required for the ticket source.",
  invalidLink: "The ticket source link of the project is invalid.",
  invalidStart: "The ticket start is invalid.",
  startNotFound: "The ticket start was not found.",
  projectNotFound: "The project was not found.",
  invalidFilter: "The ticket filter is invalid.",
  codingCliRequired: "A ticket can only be started with a coding CLI.",
  alreadyStarting: "This ticket is being started right now.",
  alreadyStarted: "This ticket was already started. Confirm to start it again.",
  taskNotDelivered:
    "The task could not be handed to the new session; the session was stopped.",
  source: Object.freeze({
    unauthorized: "The ticket source rejected the credentials. Please check the token.",
    forbidden: "The ticket source token has no permission for this.",
    notFound: "The ticket source did not find the request.",
    rateLimited:
      "The ticket source is limiting requests right now. Please try again later.",
    unavailable: "The ticket source is currently unavailable.",
    unreachable: "The ticket source cannot be reached.",
    invalidResponse: "The ticket source returned an unexpected response.",
    notConnected: "The ticket source is not connected for this project.",
  }),
});
