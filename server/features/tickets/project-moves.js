// Moves a project's ticket data when the project gets a new id: a plain folder that
// became a Git work tree, or an older duplicate row merged into the current one
// (ProjectRebind). Ticket data of an id that is merely unknown is never touched.
import { ticketsProjectChanged } from "./live-topics.js";

/**
 * ProjectRebind#tickets over the ticket, rule and sequence stores: whether the old id
 * still holds ticket data, and the move itself. The queue moves inside the engine's
 * lock of both ids, so no step of either runs while it moves. Idempotent: a repeated
 * move of an id that holds nothing changes nothing.
 */
export function ticketProjectMoves({ ticketStore, rules, store, engine, live }) {
  return {
    ownsProject: (projectId) =>
      ticketStore.ownsProject(projectId) ||
      rules.ownsProject(projectId) ||
      Boolean(store.queue(projectId)),
    async moveProject(fromId, toId) {
      if (fromId === toId) return;
      ticketStore.moveProject(fromId, toId);
      rules.moveProject(fromId, toId);
      if (store.queue(fromId))
        await engine.exclusive(fromId, () =>
          engine.exclusive(toId, () => store.moveProject(fromId, toId)),
        );
      for (const id of [fromId, toId]) ticketsProjectChanged(live(), id);
    },
  };
}
