const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Replaces the address with `target` (a normalization: it never adds a history entry).
 * The workspace navigation refuses a replace while another navigation or a history
 * step is under way (resolves false); this tries again once it has settled, every
 * `wait` ms up to `tries` times, as long as `needed()` still holds. Resolves whether
 * the address was replaced.
 */
export async function replaceWhenSettled(
  navigate,
  target,
  needed = () => true,
  { tries = 20, wait = 100 } = {},
) {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (!needed()) return false;
    if ((await navigate(target, true, true)) !== false) return true;
    await pause(wait);
  }
  return false;
}
