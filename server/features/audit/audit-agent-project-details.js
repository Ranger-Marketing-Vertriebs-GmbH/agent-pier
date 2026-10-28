// A project an agent created itself or its coding switch (agentpier_project): what
// changed and two flags; never the project's name or folder path.
const changes = new Set(["create", "coding"]);

export function agentProjectAuditDetails(details, event) {
  if (details.kind !== "agent-project") return;
  if (changes.has(details.change)) event.details.change = details.change;
  for (const key of ["coding", "git"])
    if (typeof details[key] === "boolean") event.details[key] = details[key];
}
