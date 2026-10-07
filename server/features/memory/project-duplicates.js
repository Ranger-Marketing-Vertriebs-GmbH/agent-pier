import { projectScope } from "./project-scope.js";

const newestFirst = (a, b) =>
  String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id);

/**
 * Marks projects that share a folder. The current one is the row whose identity
 * matches the folder on disk now (`currentIds`: folder → id or null), else the most
 * recently registered one. It carries `olderDuplicates` (id, name, entry count,
 * registration time); every other row of that folder gets `duplicateOf`. Rows keep
 * their data; this only decides what the project hub lists.
 */
export function describeDuplicates(projects, currentIds) {
  const byFolder = new Map();
  for (const project of projects)
    byFolder.set(project.cwd, [...(byFolder.get(project.cwd) || []), project]);
  const marks = new Map();
  for (const [cwd, group] of byFolder) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(newestFirst);
    const current = group.find((row) => row.id === currentIds.get(cwd)) || sorted[0];
    const older = sorted.filter((row) => row !== current);
    marks.set(current.id, {
      olderDuplicates: older.map((row) => ({
        id: row.id,
        name: row.name,
        entries: row.entryCount || 0,
        createdAt: row.createdAt,
      })),
    });
    for (const row of older) marks.set(row.id, { duplicateOf: current.id });
  }
  return projects.map((project) =>
    marks.has(project.id) ? { ...project, ...marks.get(project.id) } : project,
  );
}

/** Folders with several project rows, mapped to the id the folder has on disk now. */
export async function currentDuplicateIds(projects) {
  const counts = new Map();
  for (const project of projects)
    counts.set(project.cwd, (counts.get(project.cwd) || 0) + 1);
  const current = new Map();
  for (const [cwd, count] of counts) {
    if (count < 2) continue;
    try {
      const scope = await projectScope(cwd);
      current.set(cwd, scope.cwd === cwd ? scope.id : null);
    } catch {
      current.set(cwd, null);
    }
  }
  return current;
}

/** The project list with duplicate folders described; see describeDuplicates. */
export async function withDuplicates(projects) {
  return describeDuplicates(projects, await currentDuplicateIds(projects));
}
