import path from "node:path";

const control = /[\x00-\x1f\x7f]/;
const controls = /[\x00-\x1f\x7f]/g;

// The valid identifiers of a list, at most 100; an invalid one is left out.
function ids(value, auditId) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).filter((id) => {
    try {
      return Boolean(auditId(id));
    } catch {
      return false;
    }
  });
}

/**
 * A deleted project (project-deletion.js): its folder, the projects nested in it,
 * the sessions and processes the owner ended for it, and whether unsaved Git work
 * was reported or the folder was already gone.
 */
export function projectDeletionAuditDetails(details, event, auditId) {
  if (event.action !== "project.deleted") return;
  const folder = details.path;
  if (
    typeof folder === "string" &&
    path.isAbsolute(folder) &&
    folder.length <= 4096 &&
    !control.test(folder)
  )
    event.details.path = folder;
  for (const key of ["nestedProjectIds", "endedSessionIds"])
    if (Array.isArray(details[key])) event.details[key] = ids(details[key], auditId);
  if (Array.isArray(details.endedProcesses))
    event.details.endedProcesses = details.endedProcesses
      .filter((item) => Number.isSafeInteger(item?.pid))
      .slice(0, 100)
      .map((item) => ({
        pid: item.pid,
        name: String(item.name ?? "")
          .replace(controls, "")
          .slice(0, 64),
      }));
  for (const key of ["unsavedGitWork", "folderMissing"])
    if (typeof details[key] === "boolean") event.details[key] = details[key];
}
