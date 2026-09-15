export function createFileNavigationCoordinator() {
  let guard = null;
  let generation = 0;
  let queue = Promise.resolve();
  return {
    register(nextGuard) {
      guard = nextGuard;
      return () => {
        if (guard === nextGuard) guard = null;
      };
    },
    request(request) {
      const owner = ++generation;
      const run = async () => {
        const accepted = guard ? await guard(request) : true;
        if (!accepted || owner !== generation) return false;
        await request.commit?.();
        return true;
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
  };
}

const coordinator = createFileNavigationCoordinator();

export const registerFileNavigationGuard = (guard) => coordinator.register(guard);
export const requestFileNavigation = (request) => coordinator.request(request);
