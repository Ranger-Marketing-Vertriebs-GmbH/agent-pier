// Pure rules of the Hermes Agent runtime state (GET /api/assistant-runtime/hermes):
// what the Runtime tab shows and when the wizard offers Hermes. No request here.

/** The state read from the server, or null when it is no Hermes state at all. */
export const validHermes = (data) =>
  data && typeof data === "object" && typeof data.enabled === "boolean" ? data : null;

/** Whether new agents may run on Hermes: switched on and installed. */
export const hermesReady = (state) => state?.enabled === true && state.installed === true;

/** Whether an install or an update runs, so the state is polled and actions wait. */
export const hermesBusy = (state) =>
  state?.installing === true || state?.updating === true;

const tones = {
  installing: "pending",
  updating: "pending",
  error: "error",
  off: "idle",
  ready: "ok",
  notInstalled: "pending",
};

/** The state row: `kind` names its text, `tone` its status dot. */
export function hermesStatus(state) {
  const kind = state?.installing
    ? "installing"
    : state?.updating
      ? "updating"
      : state?.error
        ? "error"
        : !state?.enabled
          ? "off"
          : state.installed
            ? "ready"
            : "notInstalled";
  return { kind, tone: tones[kind] };
}

/** The error text of `code` from `errors`, or `fallback(code)` for an unknown code. */
export const hermesErrorText = (code, errors, fallback) =>
  Object.hasOwn(errors, code) ? errors[code] : fallback(code);
