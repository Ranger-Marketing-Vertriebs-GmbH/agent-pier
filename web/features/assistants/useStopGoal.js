import { useState } from "react";
import { assistantApi } from "./assistant-api.js";

/**
 * The owner's Stop for a chat's open work goal (AGENTPIER-208): `stop()` resolves
 * true once the goal stopped and `onStopped` (which reloads the chat) ran; `failed`
 * stays until the next try.
 */
export default function useStopGoal(conversationId, onStopped) {
  const [stopping, setStopping] = useState(false);
  const [failed, setFailed] = useState(false);
  const stop = async () => {
    setStopping(true);
    setFailed(false);
    try {
      await assistantApi.stopGoal(conversationId);
      await onStopped?.();
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setStopping(false);
    }
  };
  return { stop, stopping, failed };
}
