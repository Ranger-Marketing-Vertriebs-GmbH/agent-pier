import React, { useState } from "react";
import { memberGrantCopy as grantCopy } from "../../../lib/i18n/messages/assistant-member-grants.js";
import { assistantApi } from "../assistant-api.js";

/**
 * The instructions a lead's edit replaced, in the member's history. Team lists carry
 * only a reference; the text loads for the owner when the entry is opened.
 */
export default function ReplacedInstructions({ memberId, entryId }) {
  const [text, setText] = useState(null);
  const load = async () => {
    if (text !== null) return;
    try {
      setText((await assistantApi.replacedInstructions(memberId, entryId)).text);
    } catch {
      /* Not loaded: a later open retries. */
    }
  };
  return (
    <details
      className="agent-granted-previous"
      onToggle={(event) => event.currentTarget.open && load()}
    >
      <summary>{grantCopy.previousInstructions}</summary>
      {text !== null && <pre>{text}</pre>}
    </details>
  );
}
