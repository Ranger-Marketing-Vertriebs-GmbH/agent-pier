// How useWorkspaceNavigation hands navigations to the navigation coordinator
// (web/lib/navigation-guard.js), where the last request wins. A page's own navigation
// (a redirect, a click) and the address normalization can be requested in one React
// commit; the normalization, computed from the address before the page's navigation,
// must not replace it. So a normalization waits while a page navigation is pending,
// and `retry()` asks for it again once none is: after a commit, a decline or a
// navigation that a later one replaced.
import { navigationReason } from "../lib/navigation-guard.js";

/**
 * Returns `run(next, replace, normalization)`, which resolves like
 * `request(...)` (true once committed). `request` is the coordinator's request,
 * `commit(next, replace)` applies the navigation, `retry()` re-runs the skipped
 * normalization.
 */
export function createNavigationRunner({ request, commit, retry }) {
  let pending = 0;
  let skipped = false;
  const settle = () => {
    pending -= 1;
    if (pending || !skipped) return;
    skipped = false;
    retry();
  };
  const run = (next, replace = false, normalization = false) => {
    if (normalization && pending) {
      skipped = true;
      return Promise.resolve(false);
    }
    // Counts until it commits (its route's own normalization may follow at once)
    // or is declined or replaced.
    let open = !normalization;
    if (open) pending += 1;
    const done = () => {
      if (!open) return;
      open = false;
      settle();
    };
    const result = request({
      next,
      reason: navigationReason({ normalization }),
      commit: () => {
        done();
        commit(next, replace);
      },
    });
    result.then(done, done);
    return result;
  };
  run.pending = () => pending;
  return run;
}
