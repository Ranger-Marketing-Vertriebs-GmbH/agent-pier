/**
 * `config.apply(id)` as the app converges it. The first config.patch of a fresh
 * Gateway (the model provider) is answered only once OpenClaw applied it, while it
 * still loads and prewarms its handlers: about 0.8 s on a fast host, 5 s under load
 * and more than its 10 s budget on a slow runner (agent-deletion-contract.test.js on
 * macos-latest; the dreaming contract in the v2.20.0-rc.4 release run). AgentPier
 * converges a timed-out configuration write with the next apply, and so does this,
 * at most `tries` times; the next apply's writes wait for the timed-out patch's late
 * answer (live-patch.js configWrite). Any other failure is passed on at once.
 */
export async function convergingApply(config, id, { tries = 3 } = {}) {
  for (let n = 1; ; n++)
    try {
      return await config.apply(id);
    } catch (error) {
      if (error?.code !== "TIMEOUT" || error.method !== "config.patch" || n >= tries)
        throw error;
    }
}
