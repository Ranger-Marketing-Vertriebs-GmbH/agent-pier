import { assistantProblem, validateSkills } from "./assistant-validation.js";
import {
  capabilityKeys,
  personalCapabilities,
  personalEligible,
  personalShell,
  personalSkills,
  shellLevels,
} from "./native-capabilities.js";

/**
 * What a lead grants a task-bound member: capability switches (`true`), bundled
 * skills (`"all"` of the lead's or named ones), a shell level and SSH on the lead's
 * grants. MCP servers stay on the member draft (`mcpServerIds`). A grant is only an
 * upper bound: what a member runs with is always the grant within what its lead
 * holds right now (memberInheritance).
 */
export const grantFlags = capabilityKeys;
// Granted later only after the owner approved (MemberGrants).
export const ownerApprovedGrants = ["shell", "ssh"];
// A member the lead says nothing about: read its memory, search and read the web.
export const defaultGrants = { memory: true, webSearch: true, webFetch: true };
const grantShell = shellLevels.filter((level) => level !== "off");
const rank = (level) => shellLevels.indexOf(level);

/** A submitted grant set (proposal or later grant), normalized; shape only. */
export function grantInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw assistantProblem("invalid");
  const known = [...grantFlags, "skills", "shell", "ssh"];
  if (Object.keys(value).some((key) => !known.includes(key)))
    throw assistantProblem("invalid");
  const grants = {};
  for (const key of grantFlags)
    if (key in value) {
      if (typeof value[key] !== "boolean") throw assistantProblem("invalid");
      if (value[key]) grants[key] = true;
    }
  if ("skills" in value) {
    if (value.skills === true) grants.skills = "all";
    else if (value.skills !== false) {
      const names = validateSkills(value.skills);
      if (names.length) grants.skills = names;
    }
  }
  if ("shell" in value) {
    if (!shellLevels.includes(value.shell)) throw assistantProblem("invalid");
    if (value.shell !== "off") grants.shell = value.shell;
  }
  if ("ssh" in value) {
    if (typeof value.ssh !== "boolean") throw assistantProblem("invalid");
    if (value.ssh) grants.ssh = true;
  }
  return grants;
}

/** The default grants within what the lead holds now. */
export function defaultFor(lead) {
  const held = lead && personalEligible(lead) ? personalCapabilities(lead) : {};
  return Object.fromEntries(
    Object.keys(defaultGrants).flatMap((k) => (held[k] ? [[k, true]] : [])),
  );
}

/**
 * Refuses `grants` beyond the lead's own ceiling: a capability or skill it does not
 * hold, a shell level above its own, and shell or SSH unless `shellSsh` (the lead's
 * "Team members may use shell and SSH", for this team) is on and the lead holds
 * shell or an SSH grant (`ssh`).
 */
export function assertWithinLead(lead, grants, { shellSsh = false, ssh = false } = {}) {
  const refuse = () => {
    throw assistantProblem("teamGrantNotHeld", 409);
  };
  if (!lead || !personalEligible(lead)) refuse();
  const held = personalCapabilities(lead);
  if (grantFlags.some((key) => grants[key] && !held[key])) refuse();
  const skills = personalSkills(lead);
  if (Array.isArray(grants.skills) && grants.skills.some((n) => !skills.includes(n)))
    refuse();
  if (grants.skills === "all" && !skills.length) refuse();
  if (grants.shell) {
    const own = personalShell(lead);
    if (!shellSsh || own === "off" || rank(grants.shell) > rank(own)) refuse();
  }
  if (grants.ssh && (!shellSsh || !ssh)) refuse();
}

/**
 * What a member runs with: each grant within what the lead holds now; shell and SSH
 * only while `shellSsh`. Nothing without an eligible lead.
 */
export function memberInheritance(lead, grants = {}, shellSsh = false) {
  const eligible = !!lead && personalEligible(lead);
  const held = eligible ? personalCapabilities(lead) : {};
  const skills = eligible ? personalSkills(lead) : [];
  const own = eligible ? personalShell(lead) : "off";
  const shell =
    eligible && shellSsh && grantShell.includes(grants.shell)
      ? shellLevels[Math.min(rank(grants.shell), rank(own))]
      : "off";
  return {
    capabilities: Object.fromEntries(
      grantFlags.map((key) => [key, grants[key] === true && held[key] === true]),
    ),
    skills:
      grants.skills === "all"
        ? skills
        : Array.isArray(grants.skills)
          ? skills.filter((name) => grants.skills.includes(name))
          : [],
    shell,
    ssh: eligible && shellSsh && grants.ssh === true,
  };
}

/** `current` with `added` on top; a named skill list never narrows "all". */
export function mergeGrants(current = {}, added = {}) {
  const next = { ...current };
  for (const key of grantFlags) if (added[key]) next[key] = true;
  if (added.skills === "all") next.skills = "all";
  else if (added.skills && current.skills !== "all")
    next.skills = [...new Set([...(current.skills || []), ...added.skills])].sort();
  if (added.shell && (!current.shell || rank(added.shell) > rank(current.shell)))
    next.shell = added.shell;
  if (added.ssh) next.ssh = true;
  return next;
}

/** `current` without `removed`; removing "all" skills (or `true`) removes every one. */
export function removeGrants(current = {}, removed = {}) {
  const next = { ...current };
  for (const key of [...grantFlags, "shell", "ssh"]) if (removed[key]) delete next[key];
  if (removed.skills === "all") delete next.skills;
  else if (Array.isArray(removed.skills) && current.skills) {
    const left =
      current.skills === "all"
        ? current.skills
        : current.skills.filter((n) => !removed.skills.includes(n));
    if (Array.isArray(left) && !left.length) delete next.skills;
    else next.skills = left;
  }
  return next;
}

/** The granted keys, for notes and the audit (skill names, never server names). */
export const grantedKeys = (grants = {}) =>
  [...grantFlags, "skills", "shell", "ssh"].filter((key) => grants[key]);

/** Splits a later grant into what the lead may add itself and what needs the owner. */
export function splitGrants(grants) {
  const own = { ...grants },
    owner = {};
  for (const key of ownerApprovedGrants)
    if (key in own) {
      owner[key] = own[key];
      delete own[key];
    }
  return { own, owner };
}
