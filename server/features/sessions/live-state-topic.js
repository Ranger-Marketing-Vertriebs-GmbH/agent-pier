// The live `state` topic: the owner's workspace state (workspace-state.js) as rows,
// the same value GET /api/state answers. It is read again after every
// OperationsEvents collect (2.5 s), on native activity of any session, on inbox
// changes and on writes of accounts, provider connections, preferences and the
// installer; the hub pushes a frame only when the value changed. The slow parts
// (CLIs, PATH utilities) are sampled once a minute.
import { workspaceStateOf } from "./workspace-state.js";

export const STATE_MAX_BYTES = 131072;
export const STATE_SAMPLE_MS = 60000;

/** The topic definition for LiveHub#define. */
export function stateTopic(services) {
  const state = workspaceStateOf(services);
  return {
    name: "state",
    mode: "rows",
    maxBytes: STATE_MAX_BYTES,
    sampleMs: STATE_SAMPLE_MS,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read: () => state.read(),
    // The sample reads again with freshly detected CLIs and utilities.
    sampling: () => {
      state.invalidateSlow();
      return true;
    },
    watch({ invalidate }) {
      const changed = () => invalidate();
      const stops = [
        services.operationsEvents?.onSessions(changed),
        services.chatEvents?.subscribeAll(
          (event) => event?.type === "native-activity" && invalidate(),
        ),
        services.inbox?.subscribe(changed),
      ];
      return () => {
        for (const stop of stops) stop?.();
      };
    },
  };
}

/** Calls `listener` after each call of `object[method]` (after it settles, if async). */
function after(object, method, listener) {
  const original = object?.[method];
  if (typeof original !== "function") return;
  object[method] = function (...args) {
    const result = original.apply(this, args);
    if (typeof result?.then === "function") result.then(listener, listener);
    else listener();
    return result;
  };
}

/**
 * Signals the `state` topic on the writes it does not see through an event:
 * accounts and provider connections (both write through save()), preferences, and
 * installer jobs (their end changes the detected CLIs, so the slow parts too).
 */
export function watchStateWrites(services, hub) {
  const changed = () => hub.invalidate("state");
  const installed = () => {
    workspaceStateOf(services).invalidateSlow();
    changed();
  };
  after(services.accounts, "save", changed);
  after(services.providerConnections, "save", changed);
  after(services.preferences, "update", changed);
  after(services.installer, "remove", installed);
  const { installer } = services;
  if (typeof installer?.schedule === "function") {
    const schedule = installer.schedule;
    installer.schedule = function (...args) {
      const result = schedule.apply(this, args);
      Promise.resolve(this.active?.done).then(installed, installed);
      return result;
    };
  }
}
