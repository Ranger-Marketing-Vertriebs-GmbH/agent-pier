// The routes a split view shows, one per visible pane; null while no view is open,
// so presence falls back to the address bar.
let current = null;

export const setPresenceRoutes = (routes) => {
  current = routes;
};

export const presenceRoutes = () => current;
