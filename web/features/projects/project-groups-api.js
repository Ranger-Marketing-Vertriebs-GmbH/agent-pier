import { apiError } from "../../lib/api.js";
import { observeBuild } from "../../lib/build-check.js";
import { normalizeGroupsDocument } from "./project-groups.js";

/**
 * Saves the whole project-group document, based on `document.version`. Resolves with
 * the server's new document. A stale version rejects with an error that carries the
 * server's current document (`error.document`) for the caller to adopt.
 */
export async function saveProjectGroups(document) {
  const body = {
    version: document.version,
    groups: document.groups.map(({ id, name }) => (id ? { id, name } : { name })),
    assignments: document.assignments,
  };
  const response = observeBuild(
    await fetch("/api/project-groups", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (response.ok) return normalizeGroupsDocument(await response.json());
  const current =
    response.status === 409
      ? await response
          .clone()
          .json()
          .catch(() => null)
      : null;
  const error = await apiError(response);
  if (current) error.document = normalizeGroupsDocument(current);
  throw error;
}
