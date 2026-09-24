import test from "node:test";
import assert from "node:assert/strict";
import {
  nextReplaceStep,
  retryAfterRefusal,
  settledReplaceLimits,
} from "../../web/lib/useSettledReplace.js";

// Drives the hook's decision loop the way its effect does: one step per attempt,
// a wait or a retried refusal moves on to the next attempt.
function simulate({ settled, refusal }) {
  let attempts = 0,
    navigations = 0,
    waits = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const step = nextReplaceStep({ attempts, settled: settled(attempts) });
    if (step === "stop") break;
    if (step === "wait") {
      waits++;
      attempts++;
      continue;
    }
    navigations++;
    if (refusal === null) break;
    if (!retryAfterRefusal({ attempts, elapsed: refusal })) break;
    attempts++;
  }
  return { attempts, navigations, waits };
}

test("an accepted replace is requested once as soon as the URL has settled", () => {
  assert.deepEqual(simulate({ settled: (n) => n >= 3, refusal: null }), {
    attempts: 3,
    navigations: 1,
    waits: 3,
  });
});

test("a persistently refused replace stops at the single attempt budget", () => {
  const result = simulate({ settled: () => true, refusal: 0 });
  assert.equal(result.navigations, settledReplaceLimits.attempts);
  assert.ok(result.attempts < settledReplaceLimits.attempts);
});

test("waits and refusals share one budget", () => {
  const result = simulate({ settled: (n) => n >= 30, refusal: 0 });
  assert.equal(result.waits + result.navigations, settledReplaceLimits.attempts);
});

test("a URL that never settles stops waiting without navigating", () => {
  assert.deepEqual(simulate({ settled: () => false, refusal: 0 }), {
    attempts: settledReplaceLimits.attempts,
    navigations: 0,
    waits: settledReplaceLimits.attempts,
  });
});

test("a slow refusal, such as a declined unsaved-changes prompt, is not asked again", () => {
  assert.equal(
    simulate({ settled: () => true, refusal: settledReplaceLimits.promptAfter })
      .navigations,
    1,
  );
});
