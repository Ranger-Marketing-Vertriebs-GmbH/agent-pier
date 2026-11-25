// Pure rules of the skill lists (agent skill catalog and coding CLI skills): the search
// and the grouping by where a skill came from.
import { normalizeSearch } from "../../lib/i18n/index.js";

/** Skills whose name, description or one of `more(skill)` contains every search word. */
export function searchSkills(skills, query, more = () => []) {
  const words = normalizeSearch(query.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return skills;
  return skills.filter((skill) => {
    const text = normalizeSearch(
      [skill.name, skill.description, ...more(skill)].filter(Boolean).join(" "),
    );
    return words.every((word) => text.includes(word));
  });
}

/**
 * Groups `skills` by `sourceOf(skill)`, which returns `{ key, rank, title, ... }`.
 * Groups sort by rank, then title; skills inside a group by name. A group is its
 * source plus `skills`.
 */
export function groupSkills(skills, sourceOf) {
  const groups = new Map();
  for (const skill of skills) {
    const source = sourceOf(skill);
    if (!groups.has(source.key)) groups.set(source.key, { ...source, skills: [] });
    groups.get(source.key).skills.push(skill);
  }
  for (const group of groups.values())
    group.skills.sort((a, b) => a.name.localeCompare(b.name));
  return [...groups.values()].sort(
    (a, b) => a.rank - b.rank || a.title.localeCompare(b.title),
  );
}

/** The ref and short commit every skill of a GitHub group shares, else null. */
export function sharedRevision(skills) {
  const [first, ...rest] = skills.map((skill) => skill.origin);
  if (!first?.commit) return null;
  return rest.every(
    (origin) => origin?.commit === first.commit && origin.ref === first.ref,
  )
    ? {
        ref: first.refKind === "commit" ? "" : first.ref,
        commit: first.commit.slice(0, 7),
      }
    : null;
}

/** The line under a group label: what its skills share, joined; empty parts left out. */
export const groupMetaLine = (parts) => parts.filter(Boolean).join(" · ");
