import { useCallback, useRef } from "react";
import api from "../../lib/api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { agentAccessBody } from "./agent-device-access.js";
import { refusalText } from "./device-view.js";
import { validAccess } from "./session-device-access.js";
import { useAssignableDevices } from "./useSessionDevices.js";

const path = (agentId) => `/assistants/${encodeURIComponent(agentId)}/devices`;

/**
 * The Android devices one agent may use (agent-device-access.js), followed over the
 * live topic `agent.devices:<agentId>` (owner only), which pushes every assignment,
 * every pass of a lead and every change of a device. `offered` is false while this
 * host offers no devices: nothing is read then. `save(draft)` replaces the agent's
 * access and resolves with the server's answer once the pushed value shows it; it
 * rejects with the refusal in words. `refresh()` resolves with the access read again
 * (the one shown when that read fails).
 */
export default function useAgentDevices(agentId) {
  const offered = useAssignableDevices() !== null;
  const topic = useLiveTopic(offered && agentId ? `agent.devices:${agentId}` : null);
  const { written, refresh: read } = topic;
  const access = validAccess(topic.data) ? topic.data : null;
  const latest = useRef(access);
  latest.current = access;
  const save = useCallback(
    async (draft) => {
      try {
        const result = await api(
          path(agentId),
          "PUT",
          agentAccessBody(draft, latest.current),
        );
        await written();
        return result;
      } catch (error) {
        throw Object.assign(Error(refusalText(error)), {
          code: error?.code,
          status: error?.status,
        });
      }
    },
    [agentId, written],
  );
  const refresh = useCallback(async () => {
    const fresh = await read();
    return validAccess(fresh) ? fresh : latest.current;
  }, [read]);
  return { offered, access, error: offered ? topic.error : "", refresh, save };
}
