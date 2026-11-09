import React, { useContext, useEffect, useState } from "react";
import Checkbox from "../../../components/Checkbox.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import Icon from "../../../components/Icon.jsx";
import StatusDot from "../../../components/StatusDot.jsx";
import ValueChart from "../../../components/ValueChart.jsx";
import { formatChatTime, formatNumber } from "../../../lib/i18n/index.js";
import { agentCardsCopy as copy } from "../../../lib/i18n/messages/agent-cards.js";
import { CardActions } from "./card-actions.js";
import { stateTone, tickKey, withPendingTicks } from "./card-view.js";
import "./agent-card.css";

const toneClass = (tone) => (tone ? ` tone-${tone}` : "");

function Button({ button, disabled, onPress }) {
  return (
    <button
      type="button"
      className={`button ${button.primary ? "primary" : "secondary"} agent-card-button`}
      disabled={disabled}
      onClick={onPress}
    >
      {button.label}
    </button>
  );
}

function Table({ block, index, act }) {
  const actions = block.rows.some((row) => row.action);
  return (
    <div className="agent-card-table-wrap">
      <table className="agent-card-table">
        {block.columns && (
          <thead>
            <tr>
              {block.columns.map((column, i) => (
                <th key={i} scope="col">
                  {column}
                </th>
              ))}
              {actions && <td />}
            </tr>
          </thead>
        )}
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.cells.map((cell, c) => (
                <td key={c}>{cell}</td>
              ))}
              {actions && (
                <td className="agent-card-row-action">
                  {row.action && (
                    <Button
                      button={row.action}
                      disabled={!act.canPress}
                      onPress={() => act.press({ block: index, row: r })}
                    />
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Block({ block, index, act }) {
  switch (block.type) {
    case "heading":
      return <h4 className="agent-card-heading">{block.text}</h4>;
    case "text":
      return (
        <p className={`agent-card-text${block.muted ? " muted" : ""}`}>{block.text}</p>
      );
    case "metrics":
      return (
        <dl className="agent-card-metrics">
          {block.items.map((item, i) => (
            <div key={i} className="agent-card-metric">
              <dt>{item.label}</dt>
              <dd className={toneClass(item.tone).trim() || undefined}>{item.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "table":
      return <Table block={block} index={index} act={act} />;
    case "chart":
      return (
        <div className="agent-card-chart">
          {block.label && <h4 className="agent-card-heading">{block.label}</h4>}
          <ValueChart
            kind={block.kind}
            points={block.points}
            unit={block.unit}
            label={copy.chart(block.label)}
            formatValue={(value) => formatNumber(value)}
          />
        </div>
      );
    case "checklist":
      return (
        <fieldset className="agent-card-checklist">
          {block.title && <legend className="agent-card-heading">{block.title}</legend>}
          {block.items.map((item) => (
            <Checkbox
              key={item.id}
              label={item.text}
              checked={item.checked}
              disabled={!act.canCheck}
              onChange={(checked) => act.check({ block: index, item: item.id, checked })}
            />
          ))}
        </fieldset>
      );
    case "status":
      return (
        <ul className="agent-card-tiles">
          {block.items.map((item, i) => (
            <li key={i} className={`agent-card-tile state-${item.state}`}>
              <strong>{item.label}</strong>
              <span className="agent-card-tile-state">
                <StatusDot tone={stateTone[item.state]} />
                {copy.states[item.state]}
                {item.detail && ` · ${item.detail}`}
              </span>
            </li>
          ))}
        </ul>
      );
    case "links":
      return (
        <ul className="agent-card-links">
          {block.items.map((item, i) => (
            <li key={i}>
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                {item.label}
                <Icon name="external" size={12} />
              </a>
            </li>
          ))}
        </ul>
      );
    case "actions":
      return (
        <div className="agent-card-actions">
          {block.items.map((item, i) => (
            <Button
              key={i}
              button={item}
              disabled={!act.canPress}
              onPress={() => act.press({ block: index, item: i })}
            />
          ))}
        </div>
      );
    default:
      return null;
  }
}

/**
 * An agent card in the chat history (`card`: the server's card, see agent-cards.js
 * notesFor): its title with version and time, then its blocks. Ticks save at once
 * (shown before the chat's feed confirms them); buttons send their message as the
 * person's and work only while the chat can send. Read-only without CardActions
 * (another person's chat) and once frozen.
 */
export default function AgentCard({ card }) {
  const actions = useContext(CardActions);
  const [pending, setPending] = useState(() => new Map());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // A new version or a confirmed tick from the feed replaces what was pending.
  useEffect(() => setPending(new Map()), [card]);
  const open = !!actions?.check && !card.frozen;
  const act = {
    canCheck: open,
    canPress: open && actions.canSend && !busy,
    check: async ({ block, item, checked }) => {
      setError("");
      setPending((before) =>
        new Map(before).set(tickKey(card.version, block, item), checked),
      );
      try {
        await actions.check(card.id, { version: card.version, block, item, checked });
      } catch (e) {
        setPending(new Map());
        setError(e.message);
      }
    },
    press: async (target) => {
      setError("");
      setBusy(true);
      try {
        await actions.press(card.id, { version: card.version, ...target });
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    },
  };
  const blocks = withPendingTicks(card, pending);
  const at = Date.parse(card.updatedAt);
  return (
    <article
      className="agent-card"
      data-card-id={card.id}
      aria-label={copy.label(card.title)}
    >
      <header className="agent-card-head">
        <h3>{card.title}</h3>
        <span className="agent-card-meta">
          {card.version > 1 && `${copy.version(card.version)} · ${copy.updated} `}
          {at > 0 && formatChatTime(at)}
        </span>
      </header>
      {blocks.map((block, index) => (
        <Block key={index} block={block} index={index} act={act} />
      ))}
      {card.frozen && <p className="agent-card-note">{copy.frozen}</p>}
      {!actions && <p className="agent-card-note">{copy.readOnly}</p>}
      {open && !actions.canSend && blocks.some(pressable) && (
        <p className="agent-card-note">{copy.waiting}</p>
      )}
      <ErrorMessage error={error} />
    </article>
  );
}

const pressable = (block) =>
  block.type === "actions" ||
  (block.type === "table" && block.rows.some((row) => row.action));

/** The place a card held before its latest update: a link down to the card. */
export function AgentCardMoved({ moved }) {
  return (
    <button
      type="button"
      className="assistant-note agent-card-moved"
      aria-label={copy.showMoved(moved.title)}
      onClick={() =>
        document
          .querySelector(`[data-card-id="${CSS.escape(moved.id)}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
    >
      <Icon name="down" size={14} />
      {copy.moved(moved.title)}
    </button>
  );
}
