// Pure rules of the catalog list (Agents › Skills): how a skill reads in a row, which
// group it belongs to and which filter it matches.
import { agentSkillCatalogCopy as copy } from "../../../lib/i18n/messages/agent-skill-catalog.js";
import { skillListCopy as listCopy } from "../../../lib/i18n/messages/skill-scan.js";
import { groupMetaLine, sharedRevision } from "../../extensions/skill-groups.js";

export const catalogFilters = ["all", "used", "unused", "findings"];

/** Why the skill cannot be used right now, or null (catalogView on the server). */
export const catalogSkillLimit = (skill) =>
  skill.state === "damaged"
    ? copy.damaged
    : skill.state === "shadowed"
      ? skill.shadowedBy === "source"
        ? copy.shadowedSource
        : copy.shadowed
      : skill.state === "needsSettings" || skill.needsSettings
        ? copy.needsSettings
        : skill.state === "unavailable"
          ? copy.unavailable
          : null;

/** "2 agents" / "Unused" for a row; `long` is the sentence of the detail view. */
export function catalogSkillUsage(skill, long = false) {
  const count = (skill.agents || []).length;
  if (long) return count ? copy.agentsOn(count) : copy.agentsNone;
  return count ? copy.usage(count) : copy.unused;
}

/** A scan with findings, or a state that keeps the skill from being used. */
export const hasFindings = (skill) =>
  (skill.scan?.verdict && skill.scan.verdict !== "ok") ||
  Boolean(catalogSkillLimit(skill));

export const matchesFilter = (skill, filter) =>
  filter === "used"
    ? (skill.agents || []).length > 0
    : filter === "unused"
      ? (skill.agents || []).length === 0
      : filter === "findings"
        ? hasFindings(skill)
        : true;

/** The group of a catalog skill: its GitHub repository, plain GitHub, or uploads. */
export function catalogSource(skill) {
  if (skill.importKind !== "github")
    return { key: "upload", rank: 2, title: copy.groupUploaded };
  const repository = skill.origin?.repository;
  return repository
    ? { key: `github:${repository}`, rank: 0, title: repository }
    : { key: "github", rank: 1, title: copy.groupGithub };
}

/** "main · 0123456 · 4 skills": the revision only when every skill shares it. */
export function catalogGroupMeta(group) {
  const shared = group.rank === 0 ? sharedRevision(group.skills) : null;
  return groupMetaLine([
    shared && listCopy.revision(shared.ref, shared.commit),
    listCopy.skillCount(group.skills.length),
  ]);
}
