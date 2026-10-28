// The live `session.requests:<id>` topic: a session's request list, the same value
// GET /api/sessions/:id/requests answers. RequestBroker events (created, answered,
// ended) and its onChange (touch, claim, terminal notice and its fading, reload)
// signal it; a session that starts or stops does so through the OperationsEvents
// collect, and native activity reads it again (a read also looks for a startup dialog
// on the screen). Until Claude's startup is complete a startup dialog has no signal,
// so only then does the topic sample the screen every 1.5 s.
import { inStartupWindow } from "./claude-startup-prompts.js";

export const SESSION_PARAM = /^[a-zA-Z0-9-]{1,64}$/;
export const REQUESTS_SAMPLE_MS = 1500;

/** Signals the topic of `sessionId` on `hub` (services.live, absent until it exists). */
export function requestsChanged(hub, sessionId) {
  if (typeof sessionId === "string") hub?.invalidate("session.requests", sessionId);
}

/**
 * What decides whether a frame is due: the list without what changes with every read
 * (`sampledAt`, each interaction's `age`). An interaction counts by its moment
 * (`at`, whole seconds), so a waiting list sends nothing, while another touch of the
 * same request still does.
 */
export function requestsDigest(value) {
  if (!Array.isArray(value?.requests)) return value;
  const { sampledAt: _sampledAt, ...rest } = value;
  return {
    ...rest,
    requests: value.requests.map(({ interaction, ...entry }) =>
      interaction
        ? { ...entry, interaction: { client: interaction.client, at: interaction.at } }
        : entry,
    ),
  };
}

/** A frame's list carries the server time it leaves at, also when it was read earlier. */
export const stampSampled = (value) =>
  value && typeof value === "object" ? { ...value, sampledAt: Date.now() } : value;

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
    digest: requestsDigest,
    stamp: stampSampled,
    sampleMs,
    async sampling(id) {
      const session = await services.sessions.get(id).catch(() => null);
      return Boolean(session) && inStartupWindow(services.requests, session);
    },
    watch({ param, invalidate }) {
      let status;
      const stops = [
        services.operationsEvents?.onSessions((sessions) => {
          const next = sessions.find((session) => session.id === param)?.status ?? null;
          if (status !== undefined && next !== status) invalidate();
          status = next;
        }),
        services.chatEvents?.subscribe(
          param,
          (event) => event?.type === "native-activity" && invalidate(),
        ),
      ];
      return () => {
        for (const stop of stops) stop?.();
      };
    },
  };
}
