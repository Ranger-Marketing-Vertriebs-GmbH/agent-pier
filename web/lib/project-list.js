// Asks the server which row of a shared folder is current, like the projects hub.
export const listedProjectsPath = "/memory/projects?duplicates=1";

/**
 * One row per folder, for every project list and picker: an older row of a folder
 * (`duplicateOf`) stays hidden behind its current row, which the projects hub
 * offers to merge. An older row stays listed while it is open or chosen (`keep`:
 * an ID or a list of IDs, for example from a link or an agent's grants), and when
 * it holds pipeline work (verification steps or runs) that its current row lacks,
 * so that work never looks lost.
 */
export function listedProjects(projects, keep = []) {
  const rows = projects || [];
  const kept = new Set([keep].flat().filter(Boolean));
  const byId = new Map(rows.map((project) => [project.id, project]));
  return rows.filter(
    (project) =>
      !project.duplicateOf ||
      kept.has(project.id) ||
      (project.pipelineWork && !byId.get(project.duplicateOf)?.pipelineWork),
  );
}
