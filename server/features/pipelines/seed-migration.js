import { previousSeedRoles, seedPipelines, seedProfiles } from "./profile-seeds.js";

/** Raised whenever a seed role text changes; stored seeds then get the new text once. */
export const SEED_REVISION = 2;

// The seeds every installation got before seeds were tracked: AgentPier's first
// releases created exactly these with their definitions.
const FIRST_SEEDS = [
  ...[
    "planner",
    "implementer",
    "code-reviewer",
    "security-reviewer",
    "conflict-resolver",
    "bug-hunter",
    "app-tester",
    "app-tester-interactive",
    "default",
  ].map((key) => `profile:${key}`),
  "pipeline:seed-implement-review",
];

const pipelineProfileIds = (pipeline) =>
  pipeline.graph.nodes.flatMap((node) =>
    node.kind === "parallel"
      ? node.members.map((member) => member.profileId)
      : node.profileId
        ? [node.profileId]
        : [],
  );

/**
 * Brings the built-in profiles and pipelines of a definitions document up to date,
 * once per seed: a seed that is not in `seedsApplied` yet is added unless an item of
 * its key already exists, and is recorded either way, so a seed the owner deleted never
 * comes back. A seed pipeline whose profiles are gone is recorded without being added.
 * When `seedRevision` is behind, a stored seed profile whose role is still a text an
 * earlier version seeded gets the current text; an edited role stays as it is.
 * Mutates `state` and returns whether anything changed.
 */
export function applySeeds(state, now) {
  const before = JSON.stringify([state.seedsApplied, state.seedRevision]);
  let changed = false;
  // Documents written before seeds were tracked got the first seeds with them.
  const applied = new Set(
    Array.isArray(state.seedsApplied) ? state.seedsApplied : FIRST_SEEDS,
  );
  const profiles = seedProfiles(now);
  for (const seed of profiles) {
    const key = `profile:${seed.seedKey}`;
    if (applied.has(key)) continue;
    applied.add(key);
    if (state.profiles.some((p) => p.seedKey === seed.seedKey || p.id === seed.id))
      continue;
    state.profiles.push(seed);
    changed = true;
  }
  for (const seed of seedPipelines(now)) {
    const key = `pipeline:${seed.id}`;
    if (applied.has(key)) continue;
    applied.add(key);
    if (state.pipelines.some((p) => p.id === seed.id)) continue;
    if (!pipelineProfileIds(seed).every((id) => state.profiles.some((p) => p.id === id)))
      continue;
    state.pipelines.push(seed);
    changed = true;
  }
  if (!(state.seedRevision >= SEED_REVISION)) {
    const current = new Map(profiles.map((p) => [p.seedKey, p.config.prompts.role]));
    for (const profile of state.profiles) {
      const earlier = previousSeedRoles[profile.seedKey];
      const role = profile.config?.prompts?.role;
      if (!earlier?.includes(role)) continue;
      const next = current.get(profile.seedKey);
      profile.config.prompts.role = next;
      if (profile.description === role) profile.description = next;
      profile.revision = (profile.revision ?? 0) + 1;
      profile.updatedAt = now;
      changed = true;
    }
  }
  state.seedsApplied = [...applied];
  state.seedRevision = Math.max(state.seedRevision || 1, SEED_REVISION);
  return changed || JSON.stringify([state.seedsApplied, state.seedRevision]) !== before;
}
