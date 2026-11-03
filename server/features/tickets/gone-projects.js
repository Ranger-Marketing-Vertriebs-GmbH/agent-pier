// The ticket data of projects that no longer exist: TicketService#forgetGoneProjects
// drops a gone project's source link and start records itself, and the rules,
// pickups and queue through this binding.

/**
 * TicketService#projectData over the rule and sequence stores: the project ids they
 * hold, and dropping a gone project's rules, pickups and queue (the queue inside the
 * engine's lock, so no step of it runs while it goes).
 */
export function ticketProjectData({ rules, store, engine }) {
  return {
    ids: () => [...rules.projectIds(), ...store.queues().map((queue) => queue.projectId)],
    forget: async (projectId) => {
      rules.removeProject(projectId);
      if (store.queue(projectId))
        await engine.exclusive(projectId, () => store.removeProject(projectId));
    },
  };
}
