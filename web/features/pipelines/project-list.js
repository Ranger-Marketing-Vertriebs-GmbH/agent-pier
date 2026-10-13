// Asks the server which row of a shared folder is current, like the projects hub.
export const listedProjectsPath = "/memory/projects?duplicates=1";

/**
 * One row per folder: an older row of a folder (`duplicateOf`) stays hidden behind
 * its current row, which the projects hub offers to merge. A hidden row that is
 * open right now (`keepId`, for example from a link) stays listed.
 */
export function listedProjects(projects, keepId = "") {
  return (projects || []).filter(
    (project) => !project.duplicateOf || project.id === keepId,
  );
}
