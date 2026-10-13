// Asks the server which row of a shared folder is current, like the projects hub.
export const listedProjectsPath = "/memory/projects?duplicates=1";

/**
 * One row per folder: an older row of a folder (`duplicateOf`) stays hidden behind
 * its current row, which the projects hub offers to merge. An older row stays
 * listed while it is open (`keepId`, for example from a link), and when it holds
 * pipeline work (verification steps or runs) that its current row lacks, so that
 * work never looks lost.
 */
export function listedProjects(projects, keepId = "") {
  const rows = projects || [];
  const byId = new Map(rows.map((project) => [project.id, project]));
  return rows.filter(
    (project) =>
      !project.duplicateOf ||
      project.id === keepId ||
      (project.pipelineWork && !byId.get(project.duplicateOf)?.pipelineWork),
  );
}
