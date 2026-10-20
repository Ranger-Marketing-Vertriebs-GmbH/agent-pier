// A stand-in for Claude Code's mod runtime, enough to drive a hooks module's
// `register(on)` from node:test: hooks by event, a `$` with env, clock, http and
// session nouns, manual timers, and streaming events as async generators.
export function fakeModRuntime({ env = {}, fetch, version = "2.1.304" } = {}) {
  const hooks = new Map();
  const timers = [];
  const requests = [];
  const $ = {
    env: { get: async (name) => env[name] },
    clock: {
      after: (ms, fn) => {
        const timer = {
          ms,
          fn,
          cancelled: false,
          cancel: () => (timer.cancelled = true),
        };
        timers.push(timer);
        return timer;
      },
    },
    http: {
      fetch: async (url, init) => {
        const request = { url, ...init, body: JSON.parse(init.body) };
        requests.push(request);
        return fetch
          ? fetch(request)
          : { status: 200, ok: true, headers: {}, text: "{}" };
      },
    },
    session: { version: async () => ({ version }) },
  };
  const on = (event, hook) => {
    const registration = { event, hook, catch: null };
    hooks.set(event, registration);
    return { catch: (handler) => (registration.catch = handler) };
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    $,
    on,
    hooks,
    timers,
    requests,
    settle,
    /** Every report the module sent so far, in order. */
    events: () => requests.flatMap((request) => request.body.events),
    /** Run the timers that are due (all of them), as the runtime's clock would. */
    async tick() {
      await settle();
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
      await settle();
    },
    /** Dispatch a plain event; `bottom(e)` stands for the engine beneath. */
    dispatch(event, e, bottom = async (input) => ({ ...input })) {
      const next = (input) => bottom(input);
      next.called = false;
      return hooks.get(event).hook($, e, next);
    },
    /** Dispatch a streaming event over `chunks`; resolves {chunks, result}. */
    async stream(event, e, chunks, result = { answer: "" }) {
      async function* bottom() {
        for (const chunk of chunks) yield chunk;
        return result;
      }
      const generator = hooks.get(event).hook($, e, () => bottom());
      const seen = [];
      let step = await generator.next();
      while (!step.done) {
        seen.push(step.value);
        step = await generator.next();
      }
      return { chunks: seen, result: step.value };
    },
  };
}
