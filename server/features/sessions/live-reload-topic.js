// The live `session.reload:<id>` topic, owner only: whether and how a session can be
// reloaded, the value GET /sessions/:id/reload answers. SessionReload signals every
// write of the reload state (a request, its start, its end, a cancel). The activity
// of the CLI (busy or idle) and its native conversation are read from sources that
// announce nothing, so the topic is sampled every 1.5 s (the dialog's former poll)
// while a visible tab watches, and native activity of the session samples it at
// once. An unknown session is the route's 404.
import { SESSION_PARAM } from "../requests/live-topics.js";

export const RELOAD_SAMPLE_MS = 1500;

/** The reload state of `sessionId` changed: signals its topic on `hub`. */
export function reloadChanged(hub, sessionId) {
  if (typeof sessionId === "string") hub?.invalidate("session.reload", sessionId);
}

/** The topic definition for LiveHub#define. `sampleMs` is for tests. */
export function sessionReloadTopic(services, { sampleMs = RELOAD_SAMPLE_MS } = {}) {
  return {
    name: "session.reload",
    mode: "state",
    param: SESSION_PARAM,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    sampleMs,
    read: (_principal, id) => services.reload.status(id),
    watch({ param, nudge }) {
      return services.chatEvents?.subscribe(
        param,
        (event) => event?.type === "native-activity" && nudge(),
      );
    },
  };
}
