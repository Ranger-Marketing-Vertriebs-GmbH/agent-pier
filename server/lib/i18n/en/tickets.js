/** English messages of the ticket sources (GitHub issues, Plane work items). */
export const tickets = Object.freeze({
  connectionNotFound: "The ticket source connection was not found.",
  connectionInUse: "A project still uses this connection.",
  invalidBaseUrl:
    "The ticket source address must start with https:// (http:// only for localhost) and must not contain credentials, a query or a fragment.",
  invalidWorkspace: "The workspace slug of the ticket source is invalid.",
  invalidToken: "The ticket source token is invalid.",
  tokenRequired: "A token is required for the ticket source.",
  tokenRequiredForAddress:
    "Enter the API key again: the saved key stays with the old address of the ticket source.",
  invalidLabel: "The GitHub label must have 1 to 50 characters and no comma.",
  invalidLink: "The ticket source link of the project is invalid.",
  invalidStart: "The ticket start is invalid.",
  startNotFound: "The ticket start was not found.",
  ticketNotFound: "The ticket was not found in the ticket source.",
  planeProjectNotFound: "The Plane project was not found.",
  workspaceNotFound:
    "Plane does not know this connection's workspace. Please check the workspace slug.",
  projectNotFound: "The project was not found.",
  invalidFilter: "The ticket filter is invalid.",
  codingCliRequired: "A ticket can only be started with a coding CLI.",
  alreadyStarting: "This ticket is being started right now.",
  alreadyStarted: "This ticket was already started. Confirm to start it again.",
  taskNotDelivered:
    "The task could not be handed to the new session; the session was stopped.",
  invalidSequence: "The ticket sequence is invalid.",
  invalidRule: "The label rule is invalid.",
  invalidRuleLabel:
    "The label needs 1 to 50 characters, without commas or control characters.",
  ruleNotFound: "The label rule was not found.",
  tooManyRules: "This project already has 20 label rules.",
  ruleExists: "A rule for this source and label already exists.",
  rulesLocked:
    "The label rules are off and read-only: their file comes from a newer AgentPier version or cannot be read.",
  sequenceFull: "The ticket queue of this repository is full.",
  ticketQueued: "This ticket is already queued.",
  itemNotFound: "The queued ticket was not found.",
  itemBusy: "This ticket is being worked on right now.",
  itemRunActive:
    "The ticket's pipeline run is still active. Let it finish or cancel it first.",
  githubRequired: "Ticket sequences need a GitHub repository for this project.",
  ruleGithubRequired:
    "Label rules need a GitHub repository for this project, also for Plane tickets.",
  worktreeLeftover:
    "The folder of the last attempt is still in .worktrees/ and has local changes or another branch. Check and remove the folder, then retry.",
  prUnreadable:
    "GitHub could not be read, so AgentPier cannot turn off auto-merge or the merge queue for this pull request. Confirm to go on anyway, then check the pull request on GitHub.",
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
