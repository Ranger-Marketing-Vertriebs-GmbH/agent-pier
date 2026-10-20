/** English counterpart of de/pipelines.js with identical keys. */
export const pipelines = Object.freeze({
  invalidIdentifier: "Invalid pipeline identifier.",
  runNotFound: "Pipeline run not found.",
  runChanged: "Pipeline run changed. Reload and retry.",
  engineClosed: "Pipeline engine is closed.",
  invalidPage: "Invalid pipeline page.",
  invalidStatus: "Invalid pipeline status.",
  invalidPageFilter: "Invalid pipeline page",
  invalidStatusFilter: "Invalid status filter",
  invalidProjectFilter: "Invalid project filter",
  invalidStatusValue: "Invalid pipeline status",
  artifactPathRequired: "An artifact path is required",
  invalidVerificationStepFilter: "Invalid verification step",
  invalidEnabledFilter: "Invalid enabled filter",
  profileDisabledFilter: "This profile is disabled",
  activeRunsBlockDelete: "A pipeline with active runs cannot be deleted",
  workingDirectoryAndTaskRequired: "A working directory and task are required.",
  stageCannotBeRetried: "This stage cannot be retried.",
  finishBeforePublishing: "Finish or cancel the run before publishing its branch.",
  cancelBeforeDeleting: "Cancel the run before deleting it.",
  importedHistoryReadOnly:
    "Imported pipeline history is read-only. Start a new run to continue working.",
  actionUnavailable: "This action is not available for the current pipeline state.",
  invalidUsageResetTime: "Invalid usage reset time.",
  feedbackSize: "Feedback must contain between 1 and 32768 bytes.",
  invalidLoopFeedback: "Invalid loop feedback.",
  operatorRepairRound: "Operator requested another repair round.",
  reconcileRequiresQuiescedTurn:
    "Reconciliation requires a successful, quiesced native turn.",
  noFreshVerdict: "No fresh valid verdict is available to reconcile.",
  overrideRequiresStoppedTurn: "Override requires a stopped, quiesced native turn.",
  runAlreadyFinished: "Pipeline run already finished.",
  nodeNotFound: "Pipeline node not found.",
  artifactNotDeclared: "Artifact was not declared by this stage.",
  artifactPathPrivate: "Artifact path is private.",
  artifactNotFound: "Artifact not found.",
  invalidVerificationStep: "Invalid verification step.",
  verificationLogNotFound: "Verification log not found.",
  invalidArtifactPath: "Invalid artifact path.",
  artifactSymlinksForbidden: "Artifact symlinks are not allowed.",
  artifactNotRegularFile: "Artifact is not a regular file.",
  verdictNotJson: "Verdict is not valid JSON.",
  verdictNotObject: "Verdict must be an object.",
  verdictResultAndSummary: "Verdict requires a pass/fail result and a summary.",
  verdictRequiresHumanBoolean: "Verdict requiresHuman must be a boolean.",
  verdictFindingsArray: "Verdict findings must be an array.",
  verdictFindingTitle: "Verdict finding needs a title.",
  verdictResponsesArray: "Verdict responses must be an array.",
  verdictResponseFinding: "A verdict response needs the id of its finding.",
  verdictResponseStatus:
    "A verdict response needs the status fixed, not-fixed or disputed.",
  verdictResponseReason: "A not-fixed or disputed verdict response needs a reason.",
  verdictCriteriaArray: "Verdict acceptance criteria must be an array.",
  verdictCriterionId: "An acceptance criterion entry needs the criterion's id, e.g. AC1.",
  verdictCriterionStatus:
    "An acceptance criterion entry needs the status met or not-met.",
  verdictCriterionEvidence: "An acceptance criterion entry needs evidence.",
  specSingle: "A verdict may declare only one file with the role spec.",
  specOutsideReports:
    "The spec must lie in this stage's report directory and be declared as an artifact with the role spec.",
  specMissing: "The file declared as spec was not found.",
  specUnreadable: "The file declared as spec could not be read safely.",
  specTooLarge: "The spec exceeds 64 KiB.",
  specNoCriteria:
    'The spec needs a "## Acceptance criteria" section with a numbered list of criteria.',
  specText: "The spec must contain between 1 and 65536 bytes of text.",
  specRedeclare:
    "The spec file changed but was not declared again. Write the complete spec as spec.md into this turn's report directory and declare it with the role spec.",
  specRevisionNotFound: "This spec revision was not found.",
  specRevisionImported:
    "An imported run keeps only the text of the current spec; earlier revisions are not available.",
  specFileUnsafe: "The spec file in the worktree cannot be written safely.",
  verdictTooLarge: "Verdict exceeds 64 KiB.",
  verdictUnreadable: "Verdict could not be read safely.",
  invalidTurn: "Invalid pipeline turn.",
  unsafeVerdictDirectory: "Unsafe pipeline verdict directory.",
  unsafeReportDirectory: "Unsafe pipeline report directory.",
  invalidVerificationReceipt: "Invalid verification receipt.",
  unsafeVerificationDirectory: "Unsafe verification job directory.",
  invalidVerificationPlan: "Invalid verification plan.",
  verificationJobExists: "Verification job already exists.",
  verificationCancellationPending: "Verification cancellation is still pending.",
  invalidVerificationResult: "Invalid verification result.",
  verificationConfigUnavailable: "Verification configuration could not be loaded.",
  verificationNotStarted: "Verification could not be started.",
  verificationUntrustworthy:
    "Verification did not produce trustworthy completed results.",
  verificationFailedThreeTimes: "Verification still failed after three attempts.",
  frozenAccountRequired: "A frozen account configuration is required.",
  frozenConnectionRequired: "A frozen provider connection configuration is required.",
  noNativeConversationToResume:
    "The previous turn has no verified native conversation to resume.",
  invalidNativeConversation: "Invalid native conversation identity.",
  sessionOwnershipMismatch: "Pipeline session ownership does not match.",
  invalidSessionMode: "Invalid pipeline session mode.",
  observationRequiresTurn: "Native observation requires an owned pipeline turn.",
  useFeedbackControls: "Use pipeline feedback controls for this headless turn.",
  invalidObservationFile: "Invalid native observation file.",
  observationEventTooLarge: "Native event exceeds the 16 MiB observation limit.",
  invalidNativeJsonl: "Native CLI emitted invalid JSONL.",
  stageWorkspaceUnsafe: "The stage workspace could not be prepared safely.",
  stageLaunchFailed:
    "The stage could not be launched. Check its account and native session.",
  portRangeExhausted:
    "No free port block for the stage. Finish running stages or widen pipelines.portRangeStart and portRangeEnd in config.json.",
  membersBlocked:
    "At least one member of the parallel group needs a decision before the group concludes.",
  groupChangedFiles:
    "A member of the parallel group changed the working tree. Review the changes before the group concludes.",
  groupReadOnlyUnproven:
    "The parallel group's starting commit is missing, so AgentPier cannot show that the members left the working tree unchanged. Review the changes before the group concludes.",
  groupVerificationFailed:
    "Verification failed. A parallel group only reviews and does not repair.",
  usageLimitReached: "Native provider usage limit reached.",
  budgetExceeded:
    "The run exceeded its token budget. No new turn starts until the budget is raised.",
  invalidTokenBudget: "The token budget must be a whole number from 1 to 1,000,000,000.",
  // The UI shows the formatted token count beside the field.
  budgetBelowUsage:
    "The new token budget must be above the tokens the run reported so far.",
  nativeTurnFailed:
    "The native stage turn ended unsuccessfully. Inspect its terminal output.",
  // The argument is native CLI output and keeps its original language.
  nativeTurnFailedWith: (error) => `The native stage turn ended unsuccessfully: ${error}`,
  verdictMissing: "The stage did not provide a fresh verdict.",
  pullRequestPublishFailed:
    "The run branch or pull request could not be published. Retry the PR action.",
  pullRequestUpdateFailed:
    "The existing pull request branch could not be updated. The workspace is preserved.",
  operationInterrupted:
    "The prior operation was interrupted. Inspect the preserved workspace before retrying.",
  inactivityTimeout:
    "The native turn produced no output within its inactivity limit and was stopped.",
  turnTimeout: "The native turn exceeded its maximum run time and was stopped.",
  verificationStepFailed: (step, exitCode) =>
    `Verification step "${step}" failed with exit code ${exitCode}.`,
  verificationStepTimedOut: (step) => `Verification step "${step}" timed out.`,
  turnNotRecovered:
    "The exact native turn could not be recovered. Its workspace is preserved.",
  checkpointFailed:
    "The stage changes could not be checkpointed. The workspace is preserved.",
  riskTooManyChanges:
    "The run changes too many files to match them against the risk rules.",
  riskCheckFailed:
    "The changed paths could not be matched against the project's risk rules. Approving continues the run without this check.",
  unsafeStorage: "Unsafe pipeline storage.",
  unsafeDatabase: "Unsafe pipeline database.",
});
