import React, { useState } from "react";
import StatusDot from "../../components/StatusDot.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantApi } from "./assistant-api.js";
import { workGoalCopy } from "../../lib/i18n/messages/work-goals.js";

// The chat's open work goal under the header (AGENTPIER-208): what the agent works
// towards until it is done, and the owner's Stop. `onStopped` reloads the chat.
export default function WorkGoalLine({ goal, conversationId, onStopped }) {
  const [stopping, setStopping] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!goal) return null;
  const text = workGoalCopy.line(goal.title);
  const stop = async () => {
    setStopping(true);
    setFailed(false);
    try {
      await assistantApi.stopGoal(conversationId);
      await onStopped?.();
    } catch {
      setFailed(true);
    } finally {
      setStopping(false);
    }
  };
  return (
    <div className="assistant-goal-line" role="status">
      <StatusDot tone="working" />
      <span className="assistant-goal-title" title={text}>
        {text}
      </span>
      <ErrorMessage error={failed && workGoalCopy.stopFailed} />
      <button
        type="button"
        className="button secondary compact"
        disabled={stopping}
        onClick={stop}
      >
        {workGoalCopy.stop}
      </button>
    </div>
  );
}
