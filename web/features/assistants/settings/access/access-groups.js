// Pure rules of the Access tab's groups (handoff 5.4, 5.5): which granted entries a
// group shows inline, the candidates its inline add field offers, and how adding
// writes into the tab draft. Kept free of React for tests/unit/agent-access-groups.test.js.
import { setFolderLevel, setSshGrant, sortedIds } from "../agent-settings-fields.js";

/** Granted entries a group shows before "n weitere · Alle anzeigen". */
export const inlineLimit = 5;

/** The first `limit` entries and how many are left for the full subpage. */
export function firstEntries(entries, limit = inlineLimit) {
  return { shown: entries.slice(0, limit), more: Math.max(0, entries.length - limit) };
}

/** Items of `catalog` whose id is in `ids`, in catalog order. */
export const grantedItems = (catalog, ids) => {
  const wanted = new Set(ids);
  return (catalog || []).filter((item) => wanted.has(item.id));
};

/**
 * The granted projects of a draft: for an agent the projects it may use (coding), for
 * an agent of users the folders it may reach (`foldersOnly`).
 */
export const grantedProjectIds = (values, foldersOnly) =>
  foldersOnly ? Object.keys(values.projectFiles || {}) : values.projectIds;

/** The draft after adding `ids` as projects with folder `level` ("none" = coding only). */
export function addProjects(values, ids, level, foldersOnly) {
  let projectFiles = values.projectFiles;
  for (const id of ids)
    projectFiles = setFolderLevel(
      projectFiles,
      id,
      foldersOnly && level === "none" ? "read" : level,
    );
  return {
    projectIds: foldersOnly
      ? values.projectIds
      : sortedIds([...values.projectIds, ...ids]),
    projectFiles,
  };
}

/** The draft after removing project `id` and its folder access. */
export function removeProject(values, id, foldersOnly) {
  return {
    projectIds: foldersOnly
      ? values.projectIds
      : values.projectIds.filter((value) => value !== id),
    projectFiles: setFolderLevel(values.projectFiles, id, null),
    // A project the agent may not use cannot hold the coding sessions grant.
    sessionProjectIds: (values.sessionProjectIds || []).filter((value) => value !== id),
  };
}

/** The draft's coding sessions grant with project `id` switched `on` or off (sorted). */
export const setSessionProject = (values, id, on) => ({
  sessionProjectIds: on
    ? sortedIds([...(values.sessionProjectIds || []), id])
    : (values.sessionProjectIds || []).filter((value) => value !== id),
});

/** The SSH grants after adding `ids` with one `mode`; existing grants keep theirs. */
export function addSshGrants(grants, ids, mode) {
  return ids.reduce(
    (next, id) =>
      next.some((g) => g.accessId === id) ? next : setSshGrant(next, id, mode),
    grants,
  );
}

/** `ids` with `added` merged in, sorted like the server keeps them. */
export const addIds = (ids, added) => sortedIds([...(ids || []), ...added]);
export const removeId = (ids, id) => (ids || []).filter((value) => value !== id);

/** AddPicker candidates of a list: { id, name, sub, group }. */
export const candidatesOf = (items, describe = () => ({})) =>
  (items || []).map((item) => ({ id: item.id, name: item.name, ...describe(item) }));
