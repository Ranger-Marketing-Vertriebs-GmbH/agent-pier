import { remoteShort } from "./project-presentation.js";
import { normalizePath } from "./useProjectHub.js";

export const PROJECT_VIEWS = Object.freeze(["groups", "origin", "list"]);

const compare = (a, b) =>
  String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
const byName = (a, b) => compare(a.name, b.name) || compare(a.path, b.path);

// Owner of "owner/repo" (as `remoteShort()` returns it); "" without a remote.
export function remoteOwner(remote) {
  return remoteShort(remote).split("/")[0] || "";
}

function matches(project, query) {
  return (
    String(project.name || "")
      .toLowerCase()
      .includes(query) || remoteShort(project.remote).toLowerCase().includes(query)
  );
}

const section = (key, kind, projects, extra = {}) => ({
  key,
  kind,
  ...extra,
  projects,
  count: projects.length,
});

/**
 * Ordered sections for the projects page.
 * `document` is `{ groups: [{ id, name }], assignments: { path: groupId } }` (or null).
 * Assignments to unknown groups or paths that are not in `projects` are ignored.
 * With a query, sections without matches are hidden; the caller opens all of them.
 */
export function buildProjectSections({
  projects = [],
  document = null,
  view = "groups",
  query = "",
} = {}) {
  const needle = String(query || "")
    .trim()
    .toLowerCase();
  const shown = projects
    .filter((project) => !needle || matches(project, needle))
    .sort(byName);

  if (view === "list") {
    return needle && !shown.length ? [] : [section("list", "flat", shown)];
  }

  if (view === "origin") {
    const owners = new Map(); // lower-case owner -> { title, projects }
    const local = [];
    for (const project of shown) {
      const owner = remoteOwner(project.remote);
      if (!owner) {
        local.push(project);
        continue;
      }
      const entry = owners.get(owner.toLowerCase()) || { title: owner, projects: [] };
      entry.projects.push(project);
      owners.set(owner.toLowerCase(), entry);
    }
    const result = [...owners.values()]
      .sort((a, b) => compare(a.title, b.title))
      .map((entry) =>
        section(`origin:${entry.title.toLowerCase()}`, "origin", entry.projects, {
          title: entry.title,
        }),
      );
    if (local.length) result.push(section("local", "local", local));
    return result;
  }

  const groups = Array.isArray(document?.groups) ? document.groups : [];
  const assignments = document?.assignments || {};
  const known = new Set(groups.map((group) => group.id));
  const members = new Map(groups.map((group) => [group.id, []]));
  const ungrouped = [];
  for (const project of shown) {
    const groupId = assignments[normalizePath(project.path)];
    if (known.has(groupId)) members.get(groupId).push(project);
    else ungrouped.push(project);
  }
  const result = groups
    .filter((group) => !needle || members.get(group.id).length)
    .map((group) =>
      section(`group:${group.id}`, "group", members.get(group.id), {
        title: group.name,
        groupId: group.id,
      }),
    );
  if (ungrouped.length) result.push(section("ungrouped", "ungrouped", ungrouped));
  return result;
}
