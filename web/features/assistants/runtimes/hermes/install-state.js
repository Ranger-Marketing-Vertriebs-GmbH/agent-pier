// Pure rules of the Hermes Agent runtime state: what its install surface
// (InstallSurface.jsx) shows of it. The state is the `install` of Hermes's entry in
// the runtime list (../../runtime-list.js, the live topic `runtimes`), the same
// fields GET /api/assistant-runtime/hermes and its actions answer. No request here.

/** The state read from the server, or null when it is no Hermes state at all. */
export const validHermes = (data) =>
  data && typeof data === "object" && typeof data.enabled === "boolean" ? data : null;

/** Whether an install or an update runs, so actions wait. */
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

const installSteps = new Set(["download", "python", "packages", "check", "tools"]);

/**
 * The running installation's step (`installStep`: `{ step, index, of }`, server
 * hermes-provisioning.js), or null while none runs or the state names none.
 */
export function hermesInstallStep(state) {
  const at = state?.installing === true ? state.installStep : null;
  if (!at || !installSteps.has(at.step)) return null;
  const { index, of } = at;
  return Number.isSafeInteger(index) &&
    Number.isSafeInteger(of) &&
    index >= 1 &&
    index <= of
    ? { step: at.step, index, of }
    : null;
}
