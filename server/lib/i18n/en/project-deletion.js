export const projectDeletion = {
  projectDeleting: "This project is being deleted.",
  projectNotFound: "No project is registered at this folder.",
  sessionsUnreadable:
    "The session records could not be read, so the project's sessions are not known. Try again.",
  deleteStale:
    "The folder or the projects in it changed since the check. Check again before deleting.",
  deleteName: "Type the project's name to confirm the deletion.",
  deleteBlocked:
    "Something still runs in this project or uses its folder. Stop it and check again.",
  folderReappeared:
    "The folder exists again. Check again to delete it together with its contents.",
  notFailed: "Only a deletion that failed can be retried.",
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
    unreadable: "The folder could not be read. Try again.",
  },
};
