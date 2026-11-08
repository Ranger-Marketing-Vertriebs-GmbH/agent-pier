// A project an agent created itself or its coding switch (agentpier_project): what
// changed and two flags; a rebuild it started (agentpier_craft): the rebuild's id.
// Never the project's name, folder path or the rebuild's request.
const changes = new Set(["create", "coding"]);
const rebuildId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function agentProjectAuditDetails(details, event) {
  if (details.kind === "agent-craft" && rebuildId.test(details.rebuildId ?? ""))
    event.details.rebuildId = details.rebuildId;
  if (details.kind !== "agent-project") return;
  if (changes.has(details.change)) event.details.change = details.change;
  for (const key of ["coding", "git"])
    if (typeof details[key] === "boolean") event.details[key] = details[key];
}
