// The live `session.models:<id>` topic: the model control of a session, the value
// GET /api/sessions/:id/models answers. The model is on the tmux screen and has no
// change signal, so one sampler per session reads it every 3 s while a visible tab
// subscribes, and native activity of the session samples it at once. Without an
// attached terminal there is no pty output to listen to. Only a running, interactive
// session that is not reloading is sampled. A read that fails or hangs is part of the
// value (`error: {code}`, beside the last model read), so the client shows it and an
// unchanged failure sends no further frame.
import { serverMessages } from "../../lib/i18n/de.js";
import { SESSION_PARAM } from "../requests/live-topics.js";

export const MODELS_SAMPLE_MS = 3000;
export const MODELS_READ_TIMEOUT_MS = 10000;

/** Whether the model control of `session` can be read at all. */
export const modelsReadable = (session) =>
  session?.status === "running" &&
  session.reload?.state !== "reloading" &&
  session.tool !== "shell" &&
  session.purpose !== "login";

// The refusals of a session whose model cannot be read, by the code the client
// translates (web/features/models/model-read-error.js).
const refusalCodes = new Map([
  [serverMessages.sessions.reloading, "reloading"],
  [serverMessages.sessions.stopped, "stopped"],
  [serverMessages.sessions.shellModelPickerUnavailable, "shell"],
  [serverMessages.sessions.loginModelPickerUnavailable, "login"],
]);

// A failure as the client shows it: a known refusal and a hang by code; another
// refusal (a problem with a status) with the server's own message.
function failureOf(outcome) {
  if (outcome.timeout) return { code: "timeout" };
  const { error } = outcome;
  const code = refusalCodes.get(error?.message);
  if (code) return { code };
  if (Number.isInteger(error?.status) && error.status < 500)
    return { code: "unavailable", message: String(error.message) };
  return { code: "unavailable" };
}

/**
 * Reads `models.read(id)` with a deadline. A read still running is not started twice;
 * a later read waits for it again. Unexpected failures are logged once per change.
 */
export function modelsReader(
  models,
  { timeoutMs = MODELS_READ_TIMEOUT_MS, log = console.error } = {},
) {
  const states = new Map();
  const read = async (id) => {
    let state = states.get(id);
    if (!state) states.set(id, (state = { last: null, pending: null, failure: null }));
    if (!state.pending) {
      const pending = Promise.resolve()
        .then(() => models.read(id))
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      state.pending = pending;
      pending.then(() => {
        if (state.pending === pending) state.pending = null;
      });
    }
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([state.pending, deadline]);
    clearTimeout(timer);
    if ("value" in outcome) {
      state.last = outcome.value;
      state.failure = null;
      return outcome.value;
    }
    const failure = failureOf(outcome);
    const known = failure.code !== "unavailable" || failure.message;
    if (!known && state.failure?.code !== failure.code)
      log(`AgentPier could not read the model state of session ${id}.`);
    state.failure = failure;
    return { ...(state.last || {}), error: failure };
  };
  return { read, forget: (id) => states.delete(id) };
}

/** The topic definition for LiveHub#define. `sampleMs` and `timeoutMs` are for tests. */
export function sessionModelsTopic(
  services,
  { sampleMs = MODELS_SAMPLE_MS, timeoutMs, log } = {},
) {
  const reader = modelsReader(
    { read: (id) => services.models.read(id) },
    { timeoutMs, log },
  );
  return {
    name: "session.models",
    mode: "state",
    param: SESSION_PARAM,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read: (_principal, id) => reader.read(id),
    sampleMs,
    async sampling(id) {
      return modelsReadable(await services.sessions.get(id).catch(() => null));
    },
    watch({ param, nudge }) {
      const stop = services.chatEvents?.subscribe(
        param,
        (event) => event?.type === "native-activity" && nudge(),
      );
      return () => {
        stop?.();
        reader.forget(param);
      };
    },
  };
}
