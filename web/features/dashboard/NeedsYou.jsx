import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { startPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import { systemStatusCopy } from "../../lib/i18n/messages/system-status.js";
import { connectionsRoute } from "../connections/routes.js";
import { agentsHubRoute } from "../assistants/hub-routes.js";
import { subpage } from "../settings/settings-navigation.js";
import {
  itemContext,
  itemTime,
  itemTitle,
  kindLabel,
} from "../inbox/inbox-presentation.js";
import { ATTENTION_LIMIT } from "./attention.js";
import { statusPercent } from "./system-status-format.js";

/**
 * One card's words and action: `{ kind, title, sub, time, list, action }`, where
 * `action` is `{ label, run }` or null. An inbox item opens in the Inbox's detail,
 * since the Inbox has no quick actions.
 */
function present(entry, { navigate, setModal, openStorage }) {
  if (entry.kind === "inbox") {
    const { item } = entry;
    return {
      kind: kindLabel(item),
      title: itemTitle(item),
      sub: itemContext(item),
      time: itemTime(item),
      action: {
        label: copy.attentionAction[item.type] ?? copy.attentionAction.approval,
        run: () =>
          navigate({
            view: "inbox",
            inboxTab: "all",
            itemType: item.type,
            itemId: item.id,
          }),
      },
    };
  }
  const kind = copy.attentionKind[entry.kind];
  const text = copy.attention;
  const update = (tool) => ({
    label: copy.attentionAction.update,
    run: () => setModal({ type: "update", tool: tool.id }),
  });
  switch (entry.kind) {
    case "serviceError":
      return { kind, title: text.serviceError, sub: text.serviceErrorSub };
    case "diskLow":
      return {
        kind,
        title: systemStatusCopy.diskLowTitle,
        sub: systemStatusCopy.diskLow(
          statusPercent(entry.freePercent, 1),
          statusPercent(entry.thresholdPercent),
        ),
        action: { label: copy.attentionAction.diskLow, run: openStorage },
      };
    case "agentsStopped":
      return {
        kind,
        title: text.agentsStopped,
        sub: text.agentsStoppedSub,
        action: {
          label: copy.attentionAction.agentsStopped,
          run: () => navigate(agentsHubRoute("runtime")),
        },
      };
    case "cliUpdate":
      return {
        kind,
        title: text.cliUpdate(entry.tool.name, entry.tool.minimumVersion),
        sub: entry.tool.version
          ? text.cliUpdateSub(entry.tool.version)
          : text.cliUpdateUnknown,
        action: update(entry.tool),
      };
    case "browserUpdate":
      return {
        kind,
        title: text.browserUpdate(entry.tool.name),
        sub: text.browserUpdateSub,
        action: update(entry.tool),
      };
    case "connections":
      return {
        kind,
        title: text.connections(entry.count),
        sub: text.connectionsSub,
        action: {
          label: copy.attentionAction.connections,
          run: () => navigate(connectionsRoute()),
        },
      };
    case "appUpdate":
      return {
        kind,
        title: text.appUpdate(entry.version),
        sub: text.appUpdateSub,
        action: {
          label: copy.attentionAction.appUpdate,
          run: () => navigate(subpage("updates")),
        },
      };
    case "legacyTmux":
      return {
        kind,
        title: systemStatusCopy.legacyTmuxTitle(entry.sessions.length),
        sub: systemStatusCopy.legacyTmux(entry.sessions.length),
        list: entry.sessions.map((session) => session.name || session.id),
      };
    default:
      return { kind: "", title: "" };
  }
}

function Card({ card }) {
  return (
    <li className="start-attention-card">
      <span className="start-attention-top">
        <span className="start-attention-kind">
          <Icon name="info" size={14} />
          {card.kind}
        </span>
        {card.time && (
          <small className={card.time.urgent ? "start-warn" : ""}>{card.time.text}</small>
        )}
      </span>
      <strong>{card.title}</strong>
      {card.sub && <p>{card.sub}</p>}
      {card.list && (
        <ul
          className="start-attention-list"
          aria-label={systemStatusCopy.legacyTmuxSessions}
        >
          {card.list.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
      {card.action && (
        <button
          type="button"
          className="button secondary compact"
          onClick={card.action.run}
        >
          {card.action.label}
          <Icon name="arrow" size={14} />
        </button>
      )}
    </li>
  );
}

function Row({ card }) {
  const body = (
    <>
      <StatusDot tone="waiting" />
      <span className="start-row-text">
        <small className="start-attention-kind">{card.kind}</small>
        <strong>{card.title}</strong>
        {card.list && <small>{card.list.join(" · ")}</small>}
      </span>
      {card.action && <Icon name="chevron" size={16} />}
    </>
  );
  return (
    <li>
      {card.action ? (
        <button
          type="button"
          className="start-row start-attention-row"
          aria-label={`${card.kind}: ${card.title}. ${card.action.label}`}
          onClick={card.action.run}
        >
          {body}
        </button>
      ) : (
        <div className="start-row start-attention-row">{body}</div>
      )}
    </li>
  );
}

/**
 * "Needs you": up to three cards, then "n more" unfolds the rest in place. Hidden
 * while nothing is pending. Phones show compact rows (kind and title).
 */
export default function NeedsYou({ items, phone, ...effects }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const shown = expanded ? items : items.slice(0, ATTENTION_LIMIT);
  const hidden = items.length - ATTENTION_LIMIT;
  const Item = phone ? Row : Card;
  return (
    <section className="start-attention" aria-labelledby="start-attention-title">
      <div className="start-section-head">
        <h2 id="start-attention-title">{copy.needsYou}</h2>
        {hidden > 0 && (
          <button
            type="button"
            className="start-head-link"
            aria-expanded={expanded}
            aria-controls="start-attention-items"
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? copy.fewerAttention : copy.moreAttention(hidden)}
          </button>
        )}
      </div>
      <ul
        id="start-attention-items"
        className={phone ? "start-rows start-attention-rows" : "start-attention-grid"}
      >
        {shown.map((entry) => (
          <Item key={entry.id} card={present(entry, effects)} />
        ))}
      </ul>
    </section>
  );
}
