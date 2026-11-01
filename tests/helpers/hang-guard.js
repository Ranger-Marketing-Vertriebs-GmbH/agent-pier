/**
 * node:test options for a test whose waits follow process or stream progress without
 * a wall-clock budget of their own (a loaded host stretches process starts and exits
 * without limit). A real regression that never makes progress still fails, also in a
 * local run without AGENTPIER_TEST_TIMEOUT_MS. 120 s is over ten times the slowest
 * such test measured under load (a two-turn pipeline test, 9.8 s).
 */
export const hangGuard = Object.freeze({ timeout: 120_000 });
