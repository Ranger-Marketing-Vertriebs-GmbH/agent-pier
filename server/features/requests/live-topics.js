// The live `session.requests:<id>` topic: a session's request list, the same value
// GET /api/sessions/:id/requests answers. RequestBroker events (created, answered,
// ended) and its onChange (touch, claim, terminal notice, reload) signal it; a
// session that starts or stops does so through the OperationsEvents collect. A
// startup dialog has no signal (it is on the tmux screen), so the topic samples every
// 1.5 s, but only while the session is in its startup window.
import { inStartupWindow } from "./claude-startup-prompts.js";

export const SESSION_PARAM = /^[a-zA-Z0-9-]{1,64}$/;
export const REQUESTS_SAMPLE_MS = 1500;

/** Signals the topic of `sessionId` on `hub` (services.live, absent until it exists). */
export function requestsChanged(hub, sessionId) {
  if (typeof sessionId === "string") hub?.invalidate("session.requests", sessionId);
}

/**
 * What decides whether a frame is due. `interaction.age` grows with every read, so it
 * gives way to the moment of the interaction in whole seconds: a waiting list sends
 * nothing, while another touch of the same request still does. The frame keeps `age`.
 */
export function requestsDigest(value, now = Date.now()) {
  if (!Array.isArray(value?.requests)) return value;
  return {
    ...value,
    requests: value.requests.map(({ interaction, ...entry }) =>
      interaction
        ? {
            ...entry,
            interaction: {
              client: interaction.client,
              second: Math.round((now - interaction.age) / 1000),
            },
          }
        : entry,
    ),
  };
}

const owner = (principal) => principal?.role === "owner";

/** The topic definition for LiveHub#define. `sampleMs` is for tests only. */
export function sessionRequestsTopic(services, { sampleMs = REQUESTS_SAMPLE_MS } = {}) {
  return {
    name: "session.requests",
    mode: "state",
    param: SESSION_PARAM,
    authorize: owner,
    scopeKey: () => "owner",
    read: (_principal, id) => services.requests.list(id),
    digest: (value) => requestsDigest(value),
    sampleMs,
    async sampling(id) {
      const session = await services.sessions.get(id).catch(() => null);
      return Boolean(session) && inStartupWindow(services.requests, session);
    },
    watch({ param, invalidate }) {
      let status;
      return services.operationsEvents?.onSessions((sessions) => {
        const next = sessions.find((session) => session.id === param)?.status ?? null;
        if (status !== undefined && next !== status) invalidate();
        status = next;
      });
    },
  };
}
