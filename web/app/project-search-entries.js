// ⌘K actions of the projects page: Start tickets, Add label rule and Delete project.
import { searchCopy } from "../lib/i18n/messages/search.js";

/**
 * The project actions; the projects page takes each (usePageAction). `action` is
 * search-entries.js' action builder, `path` the label path above them. Delete project
 * is also found as "Remove project".
 */
export function projectActionEntries(action, path, bilingual) {
  return [
    action("start-tickets", () => searchCopy.actions.startTickets, path, {
      action: "start-tickets",
      pending: "tickets-sequence",
    }),
    action("add-label-rule", () => searchCopy.actions.addLabelRule, path, {
      action: "add-label-rule",
      pending: "ticket-rule-add",
    }),
    action(
      "delete-project",
      () => searchCopy.actions.deleteProject,
      path,
      { action: "delete-project", pending: "project-delete" },
      { aliases: [bilingual(() => searchCopy.aliases.removeProject)] },
    ),
  ];
}
