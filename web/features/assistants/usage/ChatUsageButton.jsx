import React, { useEffect, useId, useState } from "react";
import { usePageAction } from "../../../app/page-action.js";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import Sheet from "../../../components/Sheet.jsx";
import { agentChatsCopy } from "../../../lib/i18n/messages/agent-chats.js";
import { assistantUsageCopy as copy } from "../../../lib/i18n/messages/assistant-usage.js";
import { chatObservabilityCopy as tokenCopy } from "../../../lib/i18n/messages/chat-observability.js";
import useLiveTopic from "../../../lib/live/useLiveTopic.js";
import { usePane } from "../../../lib/pane-context.js";
import { formatTokens } from "../../chat/token-presentation.js";
import {
  contextText,
  costText,
  formatCost,
  hasUsage,
  tokenRows,
  usageOffered,
} from "./usage-presentation.js";
import "./agent-usage.css";

const rowLabel = (id) =>
  ({
    input: tokenCopy.input,
    output: tokenCopy.output,
    cacheRead: copy.chat.cacheRead,
    cacheWrite: copy.chat.cacheWrite,
    total: tokenCopy.total,
  })[id];

/**
 * The usage of the owner's chat on screen, as a header button: the chat's tokens so
 * far (compact), which opens a sheet with the tokens by kind, the cost where the
 * model has a price, and how full the model's context was at its last call (as a
 * row's second line: the text is too long for a value). The live
 * topic `agent.chat-usage:<conversationId>` pushes it after each finished turn.
 * Nothing for a user's chat (`enabled` false), a runtime that records no usage (the
 * agent's Overview says why), a chat that used nothing yet and a read that failed:
 * the header stays as it is, without an error. ⌘K "Usage of this chat" opens the sheet.
 */
export default function ChatUsageButton({ assistant, conversationId, enabled = true }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const offered = enabled && Boolean(conversationId) && usageOffered(assistant);
  const topic = useLiveTopic(offered ? `agent.chat-usage:${conversationId}` : null);
  const usage = topic.data;
  const shown = offered && hasUsage(usage);
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);
  // In a split view only the focused pane offers it (as the chat's other actions).
  const focused = usePane()?.focused !== false;
  usePageAction("chat-usage", () => setOpen(true), focused && shown);
  if (!shown) return null;
  const total = formatTokens(usage.tokens.total);
  const cost = costText(usage);
  const context = contextText(usage.context);
  const priced = formatCost(usage.cost) !== null;
  return (
    <>
      <button
        type="button"
        className="assistant-header-icon agent-chat-usage"
        aria-label={copy.chat.button(total)}
        title={copy.chat.button(total)}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {total}
      </button>
      <Sheet
        open={open}
        title={copy.chat.title}
        onCancel={() => setOpen(false)}
        className="agent-usage-sheet"
      >
        <ListCard label={tokenCopy.usage}>
          {tokenRows(usage).map((row) => (
            <ListRow
              key={row.id}
              className="agent-usage-row"
              label={rowLabel(row.id)}
              value={row.value}
            />
          ))}
        </ListCard>
        <ListCard label={tokenCopy.cost} className="agent-usage-facts">
          <ListRow
            className="agent-usage-row"
            label={tokenCopy.cost}
            sub={
              priced
                ? usage.cost.partial
                  ? copy.chat.costPartial
                  : undefined
                : copy.chat.noPriceHint
            }
            value={cost}
          />
          {context && (
            <ListRow
              className="agent-usage-row"
              label={copy.chat.context}
              sub={context}
            />
          )}
        </ListCard>
        {usage.pending && (
          <p
            id={`${id}-pending`}
            className="field-description agent-usage-note"
            role="status"
          >
            {copy.pending}
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="button text" onClick={() => setOpen(false)}>
            {agentChatsCopy.close}
          </button>
        </div>
      </Sheet>
    </>
  );
}
