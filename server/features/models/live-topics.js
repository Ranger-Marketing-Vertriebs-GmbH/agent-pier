// The live `session.models:<id>` topic: the model control of a session, the same value
// GET /api/sessions/:id/models answers. The model is on the tmux screen and has no
// change signal, so one sampler per session reads it every 3 s while a visible tab
// subscribes, and native activity of the session samples it at once. Without an
// attached terminal there is no pty output to listen to.
import { SESSION_PARAM } from "../requests/live-topics.js";

export const MODELS_SAMPLE_MS = 3000;

/** The topic definition for LiveHub#define. `sampleMs` is for tests only. */
export function sessionModelsTopic(services, { sampleMs = MODELS_SAMPLE_MS } = {}) {
  return {
    name: "session.models",
    mode: "state",
    param: SESSION_PARAM,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read: (_principal, id) => services.models.read(id),
    sampleMs,
    watch({ param, nudge }) {
      return services.chatEvents?.subscribe(
        param,
        (event) => event?.type === "native-activity" && nudge(),
      );
    },
  };
}
