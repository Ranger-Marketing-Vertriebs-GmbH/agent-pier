import React, { useCallback, useEffect, useState } from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { assistantWorkflowCopy } from "../../lib/i18n/messages/assistant-workflows.js";
import { scrollToChild } from "./transcript-scroll.js";

// Under the header while anything waits for the owner (handoff 2c). The count comes
// from the server's activity; the jump target is the first pending card rendered.
export default function AssistantApprovalStrip({ count, output }) {
  const [target, setTarget] = useState(false);
  const update = useCallback(
    () => setTarget(Boolean(output.current?.querySelector("[data-pending]"))),
    [output],
  );
  // useEffect, not a layout effect: the strip renders before the transcript, whose ref
  // is only attached once every layout effect has run.
  useEffect(() => {
    const element = output.current;
    if (!element) return undefined;
    update();
    const changes = new MutationObserver(update);
    changes.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-pending"],
    });
    return () => changes.disconnect();
  }, [output, update]);
  if (!count) return null;
  return (
    <button
      type="button"
      className="assistant-approval-strip"
      disabled={!target}
      onClick={() => {
        const element = output.current;
        scrollToChild(element, element?.querySelector("[data-pending]"));
      }}
    >
      <span className="assistant-approval-ring" aria-hidden="true" />
      <span className="assistant-approval-label">
        {assistantWorkflowCopy.pendingApprovals} · {count}
      </span>
      <span className="assistant-approval-show">
        {copy.showApprovals}
        <Icon name="chevron" size={14} />
      </span>
    </button>
  );
}
