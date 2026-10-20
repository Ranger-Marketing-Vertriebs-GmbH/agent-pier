/**
 * Lists every route the registered /api routers serve (api-registry.js). It walks each
 * router's stack, nested routers included, and asks a router for the routes it builds
 * lazily through `router.inventory()`, which returns more routers to walk. A method and
 * path registered twice appear twice, so a shadowed handler shows up as a duplicate.
 */
export function routeInventory(services) {
  const routes = [];
  const add = (method, path, beforeLogin) => {
    const regex = path instanceof RegExp;
    const text = regex ? String(path) : `/api${path === "/" ? "" : path}`;
    routes.push({
      method,
      path: text,
      ...(regex ? { regex } : {}),
      ...(beforeLogin ? { beforeLogin } : {}),
    });
  };
  const walk = (router, beforeLogin) => {
    for (const layer of router.stack || []) {
      if (layer.route) {
        const paths = [layer.route.path].flat();
        const methods = Object.keys(layer.route.methods).map((m) =>
          m === "_all" ? "ALL" : m.toUpperCase(),
        );
        for (const path of paths)
          for (const method of methods) add(method, path, beforeLogin);
      } else if (Array.isArray(layer.handle?.stack)) {
        // A prefix would be lost here: nested routers mount at their parent's root.
        if (!layer.slash)
          throw new Error("A nested API router must mount without a path.");
        walk(layer.handle, beforeLogin);
      }
    }
    for (const nested of [router.inventory?.() || []].flat()) walk(nested, beforeLogin);
  };
  for (const { router, beforeLogin } of services.apiRegistry.entries)
    walk(router, beforeLogin);
  return routes;
}
