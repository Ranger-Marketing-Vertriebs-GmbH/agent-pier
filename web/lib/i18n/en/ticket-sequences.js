// Ticket sequences in a project's Tickets tab: the queue with its states, the reasons
// a ticket waits for the owner (one per PARK_REASONS entry) and the owner actions.
export const ticketQueueCopy = {
  title: "Queue",
  states: {
    waiting: "Waiting",
    running: "Running",
    "awaiting-merge": "Waits for merge",
    "needs-owner": "Needs you",
    done: "Done",
  },
  reasons: {
    githubRequired: "The project has no GitHub access.",
    sourceUnavailable: "The ticket source is no longer connected.",
    ticketUnavailable: "The ticket could not be found.",
    startFailed: "The ticket could not be started.",
    startInterrupted: "AgentPier restarted while starting this ticket.",
    taskNotDelivered: "The task did not reach the session.",
    sessionEnded: "The session ended without a pull request.",
    runFailed: "The pipeline run failed.",
    noPullRequest: "The work ended without a pull request.",
    prClosed: "The pull request was closed without merging.",
    mergeDisarmed: "Auto-merge or the merge queue was turned off on GitHub.",
    armRefused: "GitHub refused auto-merge or the merge queue.",
    mergeRefused: "GitHub refused the merge.",
    idle: "The pull request stayed red for 30 minutes.",
    failedRounds: "Checks failed three times.",
    forgeUnreachable: "GitHub could not be reached for 30 minutes.",
    repairUnconfigured: "No coding session settings for the repair session.",
    repairFailed: "The repair session could not start.",
    other: "AgentPier needs your decision.",
  },
  pullRequest: (number) => `Pull request #${number}`,
  rowActions: (key) => `Queue actions for ${key}`,
  retry: "Retry",
  markDone: "Mark done",
  remove: "Remove from queue",
  openSession: "Open session",
  openRun: "Open run",
  openPullRequest: "Open pull request",
  doneTitle: (key) => `Mark ${key} as done?`,
  doneBody:
    "The sequence moves on to the next ticket. Nothing is written to the ticket in GitHub or Plane.",
  removeTitle: (key) => `Remove ${key} from the queue?`,
  removeBody:
    "The ticket leaves the sequence. Its session, pull request and tracker entry stay.",
};

// Selecting tickets in the list and the dialog that starts them as a sequence.
export const ticketSequenceStartCopy = {
  select: "Select tickets",
  selectTicket: (key) => `Select ${key}`,
  startSelected: (count) => `Start as sequence (${count})`,
  title: (count) =>
    count === 1 ? "Start 1 ticket as a sequence" : `Start ${count} tickets as a sequence`,
  order: (keys) => `AgentPier works through them one at a time, in this order: ${keys}.`,
  runAs: "Run as",
  session: "Session",
  pipeline: "Pipeline run",
  pipelineLabel: "Pipeline",
  searchPipelines: "Search pipelines",
  choosePipeline: "Choose a pipeline",
  noPipelines: "There are no pipelines yet.",
  repair: "Repair session",
  repairHint: "Starts when checks fail or changes are requested.",
  repairDefaults: "Prefilled from the newest coding session in this project.",
  allowMerge: "Allow merge",
  allowMergeHint:
    "AgentPier merges each pull request through auto-merge or the merge queue, or itself once required checks pass. Never past failing checks or requested changes.",
  start: "Start sequence",
};
