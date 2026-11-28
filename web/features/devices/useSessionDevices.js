import { useCallback } from "react";
import api from "../../lib/api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { refusalText, validDevices } from "./device-view.js";
import { validAccess } from "./session-device-access.js";

const path = (sessionId) => `/sessions/${encodeURIComponent(sessionId)}/devices`;

/**
 * The Android devices one session may use (session-device-access.js), followed over
 * the live topic `session.devices:<sessionId>` (owner only), which pushes every
 * assignment and every change of a device. `save(draft)` replaces the session's
 * access and resolves with the server's answer once the pushed value shows it; it
 * rejects with the refusal in words.
 */
export default function useSessionDevices(sessionId) {
  const topic = useLiveTopic(sessionId ? `session.devices:${sessionId}` : null);
  const { written } = topic;
  const save = useCallback(
    async (draft) => {
      try {
        const result = await api(path(sessionId), "PUT", draft);
        await written();
        return result;
      } catch (error) {
        throw Object.assign(Error(refusalText(error)), { code: error?.code });
      }
    },
    [sessionId, written],
  );
  return {
    data: validAccess(topic.data) ? topic.data : null,
    error: topic.error,
    loading: topic.loading,
    refresh: topic.refresh,
    save,
  };
}

/**
 * The devices a new session can be given, or null while this host offers none: the
 * device view (live topic `devices`) once the Android components are installed and
 * the host can run devices. A restricted user's read is refused, so it stays null.
 */
export function useAssignableDevices(enabled = true) {
  const topic = useLiveTopic(enabled ? "devices" : null);
  const view = validDevices(topic.data) ? topic.data : null;
  return view?.availability.available ? view.devices : null;
}
