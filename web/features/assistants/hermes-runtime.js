import { optionalRuntime } from "./runtime-list.js";

// Pure rules of the Hermes Agent runtime state: what the Runtime tab shows of it. The
// state is the optional runtime's `install` in the runtime list (runtime-list.js, the
// live topic `runtimes`), the same fields GET /api/assistant-runtime/hermes and its
// actions answer. No request here.

/** The state read from the server, or null when it is no Hermes state at all. */
export const validHermes = (data) =>
  data && typeof data === "object" && typeof data.enabled === "boolean" ? data : null;

/**
 * The state in the runtime list `runtimes`, or null on a server without an optional
 * runtime and while the list is unknown.
 */
export const hermesInstall = (runtimes) =>
  validHermes(optionalRuntime(runtimes)?.install);

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
