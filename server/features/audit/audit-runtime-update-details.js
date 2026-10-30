// A blocker the owner had resolved by "Pause agents and update"
// (runtime-update-resolution.js): which kind of item, what became of it and its id;
// never a message, a command or a name.
const items = [
  "chat_turn",
  "chat_summary",
  "team_task",
  "channel_input",
  "channel_notice",
  "workflow",
  "routine_run",
];
export function runtimeUpdateAuditDetails(details, event) {
  if (details.kind !== "runtime-update") return;
  if (details.via === "runtime-update") event.details.via = "runtime-update";
  if (items.includes(details.item)) event.details.item = details.item;
  if (["cancelled", "reviewed", "closed"].includes(details.result))
    event.details.result = details.result;
}
