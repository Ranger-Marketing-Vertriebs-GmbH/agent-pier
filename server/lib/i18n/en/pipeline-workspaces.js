/** English counterpart of de/pipeline-workspaces.js with identical keys. */
export const pipelineWorkspaces = Object.freeze({
  projectMismatch:
    "The prepared workspace does not match the authorized project. No native stage was launched.",
  preparationFailed:
    "Pipeline workspace could not be prepared safely. Existing files are preserved.",
  githubCredentialsUnavailable: "GitHub credentials are unavailable for this operation.",
  githubRemoteRequired: "Pull requests require a GitHub repository remote.",
  canonicalGithubRemoteRequired:
    "Pull requests require a canonical GitHub repository remote.",
  githubCliRequired: "Install the GitHub CLI before creating a pull request.",
  pullRequestOperationFailed: "GitHub could not complete the pull-request operation.",
  invalidPullRequestResponse: "GitHub returned an invalid pull-request response.",
  invalidPullRequestUrl: "GitHub returned an invalid pull-request URL.",
  gitOperationFailed:
    "The Git operation failed. Check the selected repository, branch, and credentials.",
  invalidGitReference: "Invalid Git reference.",
  gitReferenceNotCommit: "The Git reference is not a commit.",
  ownershipMismatch: "Workspace ownership does not match.",
  worktreeDirectoryUnsafe: "The owned worktree directory is unsafe.",
  worktreeExists: "The run worktree already exists.",
  preparationUnrecoverable:
    "The interrupted worktree preparation cannot be safely recovered.",
  sourceIdentityChanged: "The source repository identity changed during preparation.",
  preparationIntentMismatch:
    "The interrupted worktree no longer matches its preparation intent.",
  gitExcludeUnsafe: "The Git exclusion file is unsafe.",
  ownershipPathChanged: "Workspace ownership path changed.",
  ownershipIdentityChanged: "Workspace ownership identity changed.",
  gitOwnershipChanged: "Workspace Git ownership changed.",
  branchSwitched: "The run worktree switched to another branch.",
  processesStillRunning:
    "Wait for the owned native pipeline processes to finish before cleanup.",
  uncommittedChanges:
    "The worktree has uncommitted changes; preserve or commit them before cleanup.",
  unpublishedCommits: "The worktree has unpublished commits; push them before cleanup.",
});
