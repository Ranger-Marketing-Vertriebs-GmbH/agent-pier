import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";

// The Rebuilds page's data: the list topic (rebuilds, the owner's defaults, the eligible
// accounts, the stacks, whether Craft Anything is installed) and one rebuild's topic.
// Writes go to /api/craft/…; each awaits the topic's push so its control stays busy
// until the change shows.

/** Statuses of a rebuild whose build runs (Pause applies; follow-ups wait). */
export const runningStatuses = new Set(["starting", "building", "checking", "needs_you"]);

const rebuildPath = (id, action = "") =>
  `/craft/rebuilds/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

/** `craft.rebuilds`: `{ data, error, start(body), saveSettings(body) }`. */
export function useRebuilds() {
  const resource = useLiveTopic("craft.rebuilds");
  return {
    data: resource.data,
    error: resource.error,
    start: async (body) => {
      const view = await api("/craft/rebuilds", "POST", body);
      await resource.written();
      return view;
    },
    saveSettings: async (body) => {
      await api("/craft/settings", "PUT", body);
      await resource.written();
    },
  };
}

/**
 * `craft.rebuild:<id>`: the rebuild (null once it is gone), its actions and its last
 * 200 activity lines, read again whenever the rebuild changes (no polling). While it
 * runs, a new activity line changes it too (`activityRevision`).
 */
export function useRebuild(id) {
  const resource = useLiveTopic(id ? `craft.rebuild:${id}` : null);
  const rebuild = resource.data?.rebuild;
  const act = (action, body) => async () => {
    await api(rebuildPath(id, action), "POST", body);
    await resource.written();
  };
  const activity = useActivity(id, rebuild ? JSON.stringify(rebuild) : "");
  return {
    rebuild,
    error: resource.error,
    activity,
    written: resource.written,
    pause: act("pause"),
    resume: act("continue"),
    followUp: (request, pictures = []) =>
      act("follow-up", { request, ...(pictures.length && { pictures }) })(),
    autoMode: (on) => act("auto-mode", { on })(),
    remove: () => api(rebuildPath(id), "DELETE"),
  };
}

// The activity lines, read once per change of the rebuild (`version`).
function useActivity(id, version) {
  const [state, setState] = useState({ id: null, lines: null, error: "" });
  useEffect(() => {
    if (!id || !version) return undefined;
    const controller = new AbortController();
    api(`${rebuildPath(id, "activity")}?limit=200`, "GET", undefined, controller.signal)
      .then((result) =>
        setState({
          id,
          lines: Array.isArray(result?.lines) ? result.lines : [],
          error: "",
        }),
      )
      .catch((error) => {
        if (!controller.signal.aborted)
          setState((held) => ({ ...held, id, error: error.message }));
      });
    return () => controller.abort();
  }, [id, version]);
  return state.id === id ? state : { id, lines: null, error: "" };
}
