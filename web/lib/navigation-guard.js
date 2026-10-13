// One coordinator for every navigation that could discard unsaved work: app routes,
// browser history, editor tab closes. Guards are asked in registration order; a
// newer request invalidates an older one that still waits for a decision.
export const passiveNavigationReasons = new Set(["normalization", "tab-close"]);

/** "normalization" only for real address normalisation; every other replace is a user navigation. */
export const navigationReason = ({ normalization = false } = {}) =>
  normalization ? "normalization" : "application";

/** True when a dirty draft must ask before `request` leaves it. */
export function needsDecision(request, { dirty, stays = () => false }) {
  return (
    Boolean(dirty) && !passiveNavigationReasons.has(request?.reason) && !stays(request)
  );
}

export function createNavigationCoordinator({ target = globalThis.window } = {}) {
  const guards = [];
  let generation = 0;
  let queue = Promise.resolve();
  let holds = 0;
  const warn = (event) => {
    event.preventDefault();
    event.returnValue = "";
  };
  return {
    register(guard) {
      const entry = { guard };
      guards.push(entry);
      return () => {
        const index = guards.indexOf(entry);
        if (index >= 0) guards.splice(index, 1);
      };
    },
    request(request) {
      const owner = ++generation;
      const run = async () => {
        for (const { guard } of [...guards]) {
          // A request replaced while it waited in the queue asks no guard at all.
          if (owner !== generation) return false;
          const accepted = await guard(request);
          if (!accepted || owner !== generation) return false;
        }
        if (owner !== generation) return false;
        await request.commit?.();
        return true;
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
    holdUnload() {
      let held = true;
      if (holds++ === 0) target?.addEventListener("beforeunload", warn);
      return () => {
        if (!held) return;
        held = false;
        if (--holds === 0) target?.removeEventListener("beforeunload", warn);
      };
    },
    unloadHeld: () => holds > 0,
  };
}

const coordinator = createNavigationCoordinator();
export const registerNavigationGuard = (guard) => coordinator.register(guard);
export const requestNavigation = (request) => coordinator.request(request);
export const holdUnloadWarning = () => coordinator.holdUnload();
