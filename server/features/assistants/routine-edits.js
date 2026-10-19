import { assistantProblem, textValue } from "./assistant-validation.js";
import { exact, schedule } from "./reminder-input.js";

/**
 * Changes a routine's name, task or schedule in place (NativeRoutines.edit): the
 * binding's definition and its native job together, under the routine's revision.
 * A scheduled routine keeps a schedule (one time or cron); an event routine keeps
 * its event. `input.trigger`, when given, was already checked by the caller's own
 * rules (a lead's minimum interval) or is checked here like on creation.
 */
export function editRoutine(routines, id, bindingId, input, assertCurrent = () => {}) {
  return routines.assistants.admit(async () => {
    assertCurrent();
    exact(input, ["name", "prompt", "trigger", "revision"]);
    if (!Number.isInteger(input.revision)) throw assistantProblem("invalid");
    const agent = routines.agent(id),
      binding = routines.owned(id, bindingId);
    if (["removed", "revoked"].includes(binding.state))
      throw assistantProblem("notFound", 404);
    if ((binding.routineRevision || 1) !== input.revision)
      throw assistantProblem("conflict", 409);
    const old = binding.definition;
    const definition = {
      ...old,
      ...(input.name !== undefined ? { name: textValue(input.name, 100) } : {}),
      ...(input.prompt !== undefined ? { prompt: textValue(input.prompt, 8192) } : {}),
    };
    if (input.trigger !== undefined) {
      if (old.trigger.kind === "event" || input.trigger?.kind === "event")
        throw assistantProblem("invalid");
      definition.trigger = schedule(input.trigger);
      definition.schedule = definition.trigger;
    }
    const job = routines.find(binding, await routines.jobs(agent));
    if (!job) throw assistantProblem("unavailable", 503);
    assertCurrent();
    const connection = await routines.start();
    const want = routines.run(
      { ...binding, definition },
      definition,
      `${connection.url}/complete/${binding.id}`,
    );
    routines.bindings.patch(bindingId, { routineUpdateUnknown: true });
    const updated = await routines.assistants.runtime.client.call("cron.update", {
      id: job.id,
      patch: {
        name: definition.name,
        ...(input.trigger !== undefined ? { schedule: definition.schedule } : {}),
        payload: want.payload,
      },
    });
    routines.bindings.patch(bindingId, {
      definition,
      routineUpdateUnknown: false,
      routineRevision: input.revision + 1,
    });
    routines.assistants.changed();
    return routines.project(binding, updated);
  });
}
