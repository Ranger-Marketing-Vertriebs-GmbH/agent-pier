import React from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import { agentRunStepsCopy as copy } from "../../lib/i18n/messages/agent-run-steps.js";

/**
 * Asks before a chat is summarised (AGENTPIER-295), for the long-chat hint and the
 * chat bar's Summarize now alike: older messages are condensed for good and the chat
 * is busy meanwhile. Cancel starts on focus and sends nothing. `longChat` is
 * useLongChat's result.
 */
export default function SummariseConfirm({ longChat }) {
  if (!longChat.confirming) return null;
  const text = copy.summariseConfirm;
  return (
    <ConfirmDialog
      title={text.title}
      body={[text.body, text.busy]}
      confirmLabel={text.confirm}
      focusCancel
      onConfirm={longChat.confirmSummarise}
      onCancel={longChat.cancelSummarise}
    />
  );
}
