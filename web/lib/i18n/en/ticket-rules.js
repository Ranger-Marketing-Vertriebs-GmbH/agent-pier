// Label rules in a project's Tickets tab: the rule list, its states and errors, and the
// origin line of a queued ticket a rule picked up.
export const ticketRulesCopy = {
  title: "Label rules",
  add: "Add label rule",
  pause: "Pause",
  resume: "Resume",
  rowActions: (label) => `Actions for label rule ${label}`,
  deleteTitle: (label) => `Delete label rule "${label}"?`,
  deleteBody:
    "The rule stops picking up tickets. Tickets it already picked up stay in the queue and are never picked up again, not even by a new rule with this label.",
  empty:
    "No label rules yet. A rule adds every open ticket with its label to the queue, once.",
  picked: (count) => (count === 1 ? "1 ticket picked up" : `${count} tickets picked up`),
  paused: "Paused",
  active: "Active",
  failing: "Error",
  loadFailed: "The label rules could not be loaded.",
  fromRule: (label) => `From label rule "${label}"`,
  fromDeletedRule: "From a deleted label rule",
  capped: {
    github:
      "Only the newest 300 open issues are checked; older issues with this label are not picked up.",
    plane:
      "Only 500 work items, closed ones included, are checked; tickets with this label beyond them are not picked up.",
  },
  errors: {
    labelGone: "The label does not exist in the ticket source.",
    queueFull: "The queue is full. Further tickets are picked up once there is room.",
    notConnected: "The ticket source or GitHub is no longer connected for this project.",
    projectGone: "The project no longer exists.",
  },
};

// The dialog that adds or edits a label rule.
export const labelRuleDialogCopy = {
  titleNew: "Add label rule",
  titleEdit: "Edit label rule",
  source: "Source",
  label: "Label",
  labelHint: "Exact label name; existing open tickets with it are picked up too.",
  intro: "Each ticket the rule picks up joins the queue and runs with these settings.",
  paused: "Paused",
  pausedHint: "A paused rule picks up no tickets until you resume it.",
  save: "Save rule",
};
