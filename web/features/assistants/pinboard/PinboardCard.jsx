import React, { useContext } from "react";
import Icon from "../../../components/Icon.jsx";
import { agentPinboardCopy as copy } from "../../../lib/i18n/messages/agent-pinboard.js";
import { PinboardContext } from "./pinboard-context.js";
import { cardSummary } from "./pinboard-view.js";
import "./pinboard-card.css";

/**
 * A pinboard change in the chat history (`pinboard`: the server's card, see
 * agent-pinboard-view.js): a compact button "📌 title · what changed ›" that opens the
 * pinboard at that list. A deleted list (`gone`) is plain text; so is a card in a chat
 * without a pinboard.
 */
export default function PinboardCard({ pinboard }) {
  const { openPinboard } = useContext(PinboardContext);
  if (pinboard.gone || !openPinboard)
    return (
      <p className="assistant-note pinboard-card-gone" data-pinboard-card>
        <Icon name="pin" size={14} /> {pinboard.title} · {copy.card.gone}
      </p>
    );
  const summary = cardSummary(pinboard, copy);
  return (
    <button
      type="button"
      className="pinboard-card"
      data-pinboard-card
      aria-label={copy.card.open(pinboard.title)}
      onClick={() => openPinboard(pinboard.listId)}
    >
      <Icon name="pin" size={14} />
      <span className="pinboard-card-text">
        <strong>{pinboard.title}</strong>
        {summary && ` · ${summary}`}
      </span>
      <Icon name="chevron" size={14} />
    </button>
  );
}
