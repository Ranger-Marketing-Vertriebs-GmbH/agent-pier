// The live `state` topic: the owner's workspace state (workspace-state.js) as rows,
// the same value GET /api/state answers. It is read again after every
// OperationsEvents collect (2.5 s, reusing the session list it read), on native
// activity of any session, on inbox changes and on writes of accounts, provider
// connections, preferences and the installer; the hub pushes a frame only when the
// value changed. The topic has no hub sampler: the collect reads every 2.5 s, and
// each read detects the slow parts (CLIs, PATH utilities) again once
// workspace-state.js's 60 s cache has expired.
import { withoutReadStamp, workspaceStateOf } from "./workspace-state.js";

// A state of many sessions (about 1-3 KiB each) passes 128 KiB; like `agent.list`, a
// snapshot may reach 1 MiB, and its later changes travel as small deltas. A larger
// one goes `stale` (at most once per 10 s per tab, live-instance.js) and the tab reads
// GET /api/state instead.
export const STATE_MAX_BYTES = 1048576;

/** The topic definition for LiveHub#define. */
export function stateTopic(services) {
  const state = workspaceStateOf(services);
  return {
    name: "state",
    mode: "rows",
    maxBytes: STATE_MAX_BYTES,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read: (_principal, _param, context) => state.read({ basedOn: context?.basedOn }),
    // The read stamp (readStartedAt) changes on every read; only the state counts.
    digest: withoutReadStamp,
    watch({ invalidate }) {
      const changed = () => invalidate();
      const stops = [
        // The collect has just listed the sessions: the read reuses that list.
        services.operationsEvents?.onSessions((sessions, listedAt) => {
          state.offerSessions(sessions, listedAt);
          invalidate();
        }),
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
export function after(object, method, listener) {
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
