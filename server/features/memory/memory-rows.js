export const pageSize = 20;
/** Columns of an entry at one revision, from `entries e` joined with `revisions r`. */
export const entryColumns = `e.id,e.project_id,r.*, (SELECT created_at FROM revisions WHERE entry_id=e.id AND revision=1) AS original_created`;
export function entry(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    revision: row.revision,
    archived: Boolean(row.archived),
    createdAt: row.original_created,
    updatedAt: row.created_at,
    provenance: JSON.parse(row.provenance),
  };
}
