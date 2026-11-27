import React from "react";
import { capabilityOf } from "../../../components/capability-gate.js";
import { assistantSemanticMemoryCopy as copy } from "../../../lib/i18n/messages/assistant-semantic-memory.js";
import useLiveTopic from "../../../lib/live/useLiveTopic.js";

/**
 * Says on an agent's memory page that its search finds notes by meaning, while the
 * owner's semantic memory search is on (the live `runtime.semantic-memory` topic).
 * Only for an agent whose runtime has such a search (capability `semanticMemory`): a
 * Hermes agent has none, so nothing shows and nothing is read. `locked` (a user's own
 * agent, whose page the owner only reads) shows nothing either.
 */
export default function SemanticSearchHint({ runtime, locked = false }) {
  const offered = !locked && capabilityOf(runtime, "semanticMemory").available;
  const topic = useLiveTopic(offered ? "runtime.semantic-memory" : null);
  if (topic.data?.state !== "on" || topic.data.pending) return null;
  return <p className="assistant-note">{copy.agentHint}</p>;
}
