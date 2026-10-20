import { guardMutations } from "../application/mutation-barrier.js";

/**
 * Every /api router is mounted through this registry, so the route inventory
 * (route-inventory.js) and the access tests see each route the server serves.
 * Routers are mounted in call order; `guarded` routers hold a mutation lease for
 * each write, `beforeLogin` marks routers mounted ahead of the session check.
 */
export function createApiRegistry(app, { barrier }) {
  const routers = [];
  const entries = [];
  return {
    routers,
    entries,
    mount(router, { guarded = true, beforeLogin = false } = {}) {
      routers.push(router);
      entries.push({ router, beforeLogin });
      app.use("/api", guarded ? guardMutations(router, barrier) : router);
    },
  };
}
