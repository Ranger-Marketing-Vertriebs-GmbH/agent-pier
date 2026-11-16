export const projectDeletionCopy = {
  deleteAction: "Delete project …",
  removeAction: "Remove from AgentPier …",
  deleteTitle: (name) => `Delete project “${name}”?`,
  removeTitle: (name) => `Remove project “${name}” from AgentPier?`,
  deleteBody: (path) =>
    `The folder ${path} and everything in it is deleted from disk permanently, together with everything AgentPier keeps about the project. This cannot be undone.`,
  removeBody: (path) =>
    `The folder ${path} no longer exists. Only the data AgentPier keeps about the project is removed. This cannot be undone.`,
  typeName: (name) => `Type “${name}” to confirm`,
  confirmDelete: "Delete permanently",
  confirmRemove: "Remove from AgentPier",
  loading: "Checking the folder …",
  blockersTitle: "Still running in this project",
  blockersNote: "The project can be deleted once nothing runs in it.",
  stopSessions: "Stop sessions",
  blockerRun: (name) => `Pipeline run ${name}`,
  blockerQueued: (count) =>
    count === 1 ? "1 queued pipeline run" : `${count} queued pipeline runs`,
  blockerRebuild: (name) => `Craft rebuild ${name}`,
  processesTitle: "Other processes using the folder",
  processLabel: (name, pid) => `${name} (PID ${pid})`,
  knownSession: "Session in AgentPier",
  knownAgentCommand: "Command of an agent",
  endProcesses: "End selected",
  processOther: "Process of another system user; AgentPier cannot end it.",
  processProtected: "AgentPier needs this process; it cannot be ended.",
  scanTimeout: "The processes using the folder could not be checked.",
  rescan: "Check again",
  gitTitle: "Unsaved work is lost",
  gitChanges: (count) =>
    count === 1 ? "1 uncommitted change" : `${count} uncommitted changes`,
  gitUnpushed: (count) =>
    count === 1 ? "1 commit that no remote has" : `${count} commits that no remote has`,
  gitUnchecked: (path) => `${path} could not be checked.`,
  linkedWorktree: (path) =>
    `The linked worktree ${path} lies outside the folder and is kept; remove it by hand afterwards.`,
  nestedTitle: "These projects in the folder are deleted too",
  accessTitle: "Access",
  accessAgents: (names) => `Agents: ${names}`,
  accessUsers: (names) => `Users of these agents: ${names}`,
  accessNote: "Their access to the project ends with it.",
  folderMissing: "Folder missing",
  driveUnavailable: "Drive not available",
  deleting: "Deleting …",
  deletionFailed: "Deletion failed — Retry",
  retry: "Retry",
  filterLabel: "Show projects",
  missingFilter: (count) => `Folder missing (${count})`,
  allFilter: "All",
  refusals: {
    root: "The root of the file system cannot be deleted.",
    home: "Your home folder cannot be deleted.",
    homeParent: "A folder that contains your home folder cannot be deleted.",
    homeChild:
      "A folder directly in your home folder (such as Documents or Projects) cannot be deleted.",
    agentpier:
      "This folder holds AgentPier itself or its data, or lies inside them, and cannot be deleted.",
    mountPoint: "This folder is a mounted drive and cannot be deleted.",
    symlink:
      "This path is a link or not written as the folder's real path; only the real folder can be deleted.",
    notDirectory: "This path is not a folder.",
    driveUnavailable:
      "The drive of this folder is not available. Nothing is deleted while it is away.",
    agentpierProcess:
      "A process AgentPier needs (its server, the session server or the agents' Gateway) uses this folder, so it cannot be deleted.",
    unreadable: "The folder could not be read. Check again.",
  },
  failures: {
    EACCES:
      "AgentPier may not delete some files in the folder. Change their permissions, then retry.",
    PROJECT_DATA_LEFT:
      "The folder is deleted, but some of AgentPier's data about the project is left. Retry to remove it.",
    PROJECT_AGENTS_OFF:
      "The folder is deleted. The agents' access to the project is removed once the agents run again.",
    PROJECT_FOLDER_CHANGED:
      "The folder was replaced after the check, so it was not deleted.",
    PROJECT_DELETE_REFUSED:
      "AgentPier refused to delete this folder because it is a protected or linked path.",
    PROJECT_DELETE_BLOCKED:
      "Something runs in the project or uses its folder again. Stop it, then retry.",
    PROJECT_FOLDER_REAPPEARED:
      "The folder exists again. Delete it together with its contents with “Delete project …”.",
    PROJECT_DELETE_FAILED: "The deletion did not finish. Retry to continue it.",
  },
};
