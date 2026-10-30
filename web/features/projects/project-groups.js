import { remoteShort } from "./project-presentation.js";
import { normalizePath } from "./project-paths.js";

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

// --- The project-group document: reading it and the edits the page sends. ---

export const emptyGroupsDocument = Object.freeze({
  version: 0,
  groups: Object.freeze([]),
  assignments: Object.freeze({}),
});

/** The server's answer as `{ version, groups, assignments }`, extra keys dropped. */
export function normalizeGroupsDocument(data) {
  const groups = Array.isArray(data?.groups)
    ? data.groups
        .filter((group) => group && typeof group.name === "string")
        .map(({ id, name }) => (id ? { id, name } : { name }))
    : [];
  const assignments = {};
  if (data?.assignments && typeof data.assignments === "object")
    for (const [path, groupId] of Object.entries(data.assignments))
      if (typeof groupId === "string") assignments[normalizePath(path)] = groupId;
  return {
    version: Number.isInteger(data?.version) ? data.version : 0,
    groups,
    assignments,
  };
}

/** The group a project's folder is assigned to, or null (stale ids count as none). */
export function groupForPath(document, path) {
  const groupId = document?.assignments?.[normalizePath(path)];
  return (groupId && document.groups.find((group) => group.id === groupId)) || null;
}

// Matches the server, which compares trimmed names in lower case.
const sameName = (a, b) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

export function findGroupByName(document, name) {
  return document?.groups.find((group) => sameName(group.name, name)) || null;
}

/** "required" for an empty name, "taken" for a duplicate (ignoring case), else "". */
export function groupNameProblem(document, name, exceptId = "") {
  if (!String(name || "").trim()) return "required";
  const match = findGroupByName(document, name);
  return match && match.id !== exceptId ? "taken" : "";
}

/** Appends a new group; the server gives it its id. */
export function withNewGroup(document, name) {
  return { ...document, groups: [...document.groups, { name: String(name).trim() }] };
}

/** Puts the folder into `groupId`, or takes it out of every group with null. */
export function withAssignment(document, path, groupId) {
  const key = normalizePath(path);
  const assignments = { ...document.assignments };
  if (groupId) assignments[key] = groupId;
  else delete assignments[key];
  return { ...document, assignments };
}

/** Renames a group; the server validates and trims the name. */
export function withRenamedGroup(document, groupId, name) {
  return {
    ...document,
    groups: document.groups.map((group) =>
      group.id === groupId ? { ...group, name: String(name).trim() } : group,
    ),
  };
}

/** Moves a group `offset` places (-1 up, 1 down); the same document at the ends. */
export function withGroupMoved(document, groupId, offset) {
  const from = document.groups.findIndex((group) => group.id === groupId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= document.groups.length) return document;
  const groups = [...document.groups];
  [groups[from], groups[to]] = [groups[to], groups[from]];
  return { ...document, groups };
}

/** Moves a group to position `index`; the same document if nothing changes. */
export function withGroupAt(document, groupId, index) {
  const from = document.groups.findIndex((group) => group.id === groupId);
  const to = Math.min(Math.max(index, 0), document.groups.length - 1);
  if (from < 0 || to === from) return document;
  const groups = [...document.groups];
  groups.splice(to, 0, ...groups.splice(from, 1));
  return { ...document, groups };
}

/** Deletes a group and every assignment to it. */
export function withoutGroup(document, groupId) {
  return {
    ...document,
    groups: document.groups.filter((group) => group.id !== groupId),
    assignments: Object.fromEntries(
      Object.entries(document.assignments).filter(([, id]) => id !== groupId),
    ),
  };
}
