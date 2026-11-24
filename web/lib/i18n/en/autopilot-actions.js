export const autopilotActionsCopy = {
  newOrder: "New order",
  startOrder: "Start order",
  project: "Project",
  chooseProject: "Choose a project",
  noProjects: "Add a Git project in Projects to create an order.",
  title: "Order title",
  brief: "Brief",
  briefLimit: "Shorten the brief to 65,536 UTF-8 bytes or fewer.",
  noCli: "Install a coding CLI to start Autopilot.",
  permissions: "Order permissions",
  editPolicy: "Edit permissions",
  allowMerge: "Autopilot may merge pull requests",
  mergeHint:
    "Autopilot may merge this order’s pull requests after the required repository checks.",
  implementationAuthorized: "Allow implementation",
  implementationHint:
    "Autopilot may start pipelines for the work described in this brief.",
  granted: "Allowed",
  withheld: "Off",
  pause: "Pause order",
  resume: "Resume order",
  recover: "Recover session",
  recoveryHint:
    "Continue from the recorded checkpoint. Autopilot reuses the existing conversation when possible and opens a replacement if needed.",
  changeAccess: "Choose a different CLI or account",
  remove: "Remove order",
  finishRemoval: "Finish removal",
  removeTitle: (title) => `Remove “${title}”?`,
  removeEffect:
    "This removes the order brief and progress, the Autopilot session, and its branch and worktree. Pipeline runs and pull request history stay available.",
  stopFirst:
    "Stop the Autopilot session before removing the order. The worktree must be clean and its commits merged into the base branch.",
  typeTitle: "Enter the order title to confirm",
  openReserved: "Open reserved order",
};
