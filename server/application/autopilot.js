import { AutopilotOrders } from "../features/autopilot/autopilot-orders.js";
import { autopilotChanged } from "../features/autopilot/live-topics.js";
import { OrderResources } from "../features/autopilot/order-resources.js";
import { OrderStore } from "../features/autopilot/order-store.js";
import { orderView } from "../features/autopilot/order-view.js";
import { projectScope } from "../features/memory/project-scope.js";

export function createAutopilot(services) {
  // A newly cloned repository can first appear in Repositories, before a session
  // registers it in Memory. All callers use its Git project ID across worktrees.
  const projects = async () => {
    const known = new Map(
      services.memory
        .projects()
        .projects.filter((p) => p.kind === "git")
        .map((p) => [p.cwd, p]),
    );
    for (const clone of services.repositories.listProjects()) {
      if (known.has(clone.path)) continue;
      const p = await projectScope(clone.path).catch(() => null);
      if (p?.kind === "git" && !known.has(p.cwd)) known.set(p.cwd, p);
    }
    return [...known.values()];
  };
  const store = new OrderStore({
    dataDir: services.config.dataDir,
    projects,
    onChange: (projectId) => autopilotChanged(services.live, projectId),
  });
  const orders = new AutopilotOrders({
    store,
    resources: new OrderResources(services),
    view: (record, options) => orderView(record, services, options),
  });
  return {
    orders,
    sessionOrder: (id) => store.sessionOrder(id),
    currentSessionId: (id) => {
      const ref = store.byId(id);
      return ref?.managed && !ref.cleanup ? (ref.resources?.sessionId ?? null) : null;
    },
    assertStart: (sessionId, projectId) => store.assertStart(sessionId, projectId),
    projects: async () => ({
      projects: (await projects()).map(({ id, name, cwd }) => ({ id, name, cwd })),
    }),
    close: () => store.close(),
  };
}
