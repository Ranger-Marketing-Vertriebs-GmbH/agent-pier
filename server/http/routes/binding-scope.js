import { agentPerson, boundTo } from "../../features/assistants/reminder-audience.js";

/**
 * The owner's reminder and routine routes reach only the bindings of the agent's
 * person (reminder-audience.js): his own, or under her opt-in a user's own agent's.
 * Another user's binding on a shared agent is not found.
 */
export function ownerPerson(assistants, id) {
  return agentPerson(assistants.store.getAssistant(id));
}

export function ownerBinding({ assistants }, param) {
  return (req, _res, next) => {
    const { id } = req.params;
    boundTo(
      assistants.reminders.bindings,
      id,
      req.params[param],
      ownerPerson(assistants, id),
    );
    next();
  };
}
