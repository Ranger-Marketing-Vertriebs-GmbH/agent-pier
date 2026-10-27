import { personalEligible, personalSkills } from "./native-capabilities.js";

// Removing a skill from the agent skill catalog switches it off on every agent first
// (agent-skill-catalog.js). Only the stored lists of eligible agents change: a
// temporary member follows its lead, and an archived agent's list is left as it is
// (the compile drops a name that is neither bundled nor in the catalog).

/** The eligible agents whose stored list switches `name` on, for the confirmation. */
export function catalogUsers(assistants, name) {
  return assistants.store
    .listAssistants()
    .filter(
      (assistant) =>
        personalEligible(assistant) && personalSkills(assistant).includes(name),
    )
    .map((assistant) => ({ id: assistant.id, name: assistant.name }));
}

/** Writes the list without `name`; one retry when another save changed the revision. */
function strip(store, id, name) {
  for (let attempt = 0; ; attempt++) {
    const current = store.getAssistant(id);
    const skills = personalSkills(current);
    if (!personalEligible(current) || !skills.includes(name)) return false;
    try {
      store.updateAssistant(
        id,
        { skills: skills.filter((skill) => skill !== name) },
        current.revision,
      );
      return true;
    } catch (error) {
      if (error?.status !== 409 || attempt > 0) throw error;
    }
  }
}

/**
 * Switches `name` off on every agent that has it and applies those agents live when
 * the Gateway runs. A failed apply stays pending (the stored revision is ahead of the
 * effective one) and is retried like any other. Returns the ids of the changed agents.
 */
export async function switchOffEverywhere(assistants, name) {
  const { store, config, runtime } = assistants;
  const changed = catalogUsers(assistants, name)
    .map(({ id }) => id)
    .filter((id) => strip(store, id, name));
  if (changed.length && runtime.client?.ready)
    for (const id of changed)
      await assistants.admit(() => config.apply(id)).catch(() => {});
  if (changed.length) assistants.changed?.();
  return changed;
}
