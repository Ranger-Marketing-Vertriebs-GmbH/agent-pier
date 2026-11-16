import { builtInSkillNames } from "../../../built-in-skills.js";

// An agent's skills as Hermes takes them (website/docs/user-guide/features/skills.md),
// verified against Hermes v0.22.5. Hermes seeds every skill it bundles into the
// home's skills/ folder and offers each skill it finds there or in
// `skills.external_dirs` unless `skills.disabled` names it (agent/skill_utils.py
// get_disabled_skill_names, get_external_skills_dirs). AgentPier therefore:
// - switches off the bundled skills the owner did not switch on (`skills.disabled`);
//   the essential `hermes-agent` skill cannot be switched off (ESSENTIAL_SKILLS);
// - offers each assigned catalog skill from its folder in the catalog's live copy
//   (`skills.external_dirs`, one folder per skill, which Hermes scans for SKILL.md);
//   a skill of the same name in the home wins over it (local before external);
// - leaves skills the agent writes itself (skill_manage) on and visible: they are
//   neither bundled nor in the catalog, so nothing names them;
// - switches the review that writes them off for an agent that does not learn its
//   own skills (`skills.creation_nudge_interval: 0`). Hermes counts tool iterations
//   and, at the interval (code default 10, agent/agent_init.py), reviews the turn in
//   the background for a skill to write (agent/turn_finalizer.py,
//   agent/background_review.py); 0 never starts that. An agent that learns has no
//   key, which is Hermes's default. The `skills` toolset stays either way (it also
//   reads skills), so the agent still writes a skill when asked; the memory review
//   (`memory.nudge_interval`) and the curator are not touched.

/**
 * AgentPier's built-in skills (built-in-skills.js) the agent gets, each offered from
 * its copy in the team plugin's folder (team-plugin.js teamSkillFolder); Hermes reads
 * a relative `skills.external_dirs` entry below HERMES_HOME (agent/skill_utils.py
 * get_external_skills_dirs). `team`: whether the home carries the team plugin.
 */
export const builtInOffered = (agent, team) =>
  team ? agent.skills.compiled.filter((name) => builtInSkillNames.includes(name)) : [];

/**
 * The config.yaml entry of "Learns its own skills" for `agent` (a desiredAgent): the
 * review interval 0 for an agent that does not learn, no key (Hermes's default) for
 * one that does.
 */
export const learningEntry = (agent) => [
  ["skills", "creation_nudge_interval"],
  agent.skills.learning === false ? 0 : undefined,
];

/** Bundled skills Hermes always offers (agent/skill_utils.py ESSENTIAL_SKILLS). */
export const essentialSkills = Object.freeze(["hermes-agent"]);

/**
 * The `skills` entries of config.yaml for `agent` (a desiredAgent): `bundled`, the
 * names the installation bundles (unknown: `skills.disabled` stays as it is),
 * `catalog`, `{ [name]: folder }` of the catalog skills the start may offer, and
 * `builtIn`, `{ [name]: folder }` of AgentPier's built-in skills it gets.
 * Returns `{ entries, placed }`: config entries and the assigned names placed.
 */
export function skillEntries(agent, { bundled, catalog = {}, builtIn = {} } = {}) {
  const assigned = agent.skills.assigned;
  const known = new Set(bundled || []);
  const offered = assigned.filter(
    (name) => !known.has(name) && Object.hasOwn(catalog, name),
  );
  const entries = [
    ...(bundled
      ? [
          [
            ["skills", "disabled"],
            [...known]
              .filter(
                (name) => !assigned.includes(name) && !essentialSkills.includes(name),
              )
              .sort(),
          ],
        ]
      : []),
    [
      ["skills", "external_dirs"],
      [
        ...offered.sort().map((name) => catalog[name]),
        ...Object.keys(builtIn)
          .sort()
          .map((name) => builtIn[name]),
      ],
    ],
  ];
  const placed = assigned.filter((name) => known.has(name) || offered.includes(name));
  return { entries, placed };
}
