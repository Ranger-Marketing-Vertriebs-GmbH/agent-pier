// Pure rules of the agent skills page: filtering, search and the status text of
// one skill as the server lists it (server/features/assistants/agent-skills.js).
export const skillFilters = ["all", "on", "ready", "missing", "catalog"];
const missingKeys = ["bins", "anyBins", "env", "config", "os"];

/** Skills matching the filter (`on` reads the draft) and the search term. */
export function visibleSkills(skills, { filter = "all", term = "", on = [] } = {}) {
  const needle = term.trim().toLowerCase();
  return skills.filter((skill) => {
    if (filter === "on" && !on.includes(skill.name)) return false;
    if (filter === "catalog" && skill.source !== "catalog") return false;
    if (filter === "ready" && skill.state !== "ready") return false;
    if (filter === "missing" && skill.state === "ready") return false;
    return (
      !needle ||
      skill.name.toLowerCase().includes(needle) ||
      (skill.description || "").toLowerCase().includes(needle)
    );
  });
}

/** "Missing: programs gh; one of a, b", or "" when nothing is missing. */
export function missingText(skill, copy) {
  const parts = missingKeys
    .filter((key) => skill.missing?.[key]?.length)
    .map((key) => copy.missing[key](skill.missing[key].join(", ")));
  return parts.length ? copy.missingLine(parts.join("; ")) : "";
}

/** The status line: the state, or what is missing. */
export function statusText(skill, copy) {
  if (skill.state === "missing") return missingText(skill, copy) || copy.states.missing;
  if (skill.state === "unsupported") {
    const os = skill.missing?.os?.length ? ` (${skill.missing.os.join(", ")})` : "";
    return `${copy.states.unsupported}${os}`;
  }
  if (skill.state === "shadowed" && skill.source === "catalog")
    return copy.states.shadowedCatalog;
  return copy.states[skill.state] || copy.states.unavailable;
}

/** A switched-off skill that cannot be used is not offered; one that is on can go. */
export const skillLocked = (skill, on) =>
  !on && ["shadowed", "unavailable", "needsSettings", "damaged"].includes(skill.state);
