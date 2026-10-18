import React from "react";
import Icon from "../../components/Icon.jsx";
import { inboxCopy as copy } from "../../lib/i18n/messages/inbox.js";
import { readRoute } from "../../app/routes.js";
import { itemContext, itemIcon, itemTime, kindLabel } from "./inbox-presentation.js";
import {
  InboxActionDetail,
  InboxGateDetail,
  InboxRequestDetail,
  InboxTeamDetail,
} from "./InboxSourceDetails.jsx";
import InboxStale from "./InboxStale.jsx";

const details = {
  question: InboxRequestDetail,
  approval: InboxRequestDetail,
  gate: InboxGateDetail,
  action: InboxActionDetail,
  team: InboxTeamDetail,
};

/**
 * The selected item with its source's own card, answered through that source's
 * endpoint exactly as in place. An item that no longer waits shows how it ended.
 */
export default function InboxDetail({ type, id, item, navigate, reload }) {
  const Detail = details[type];
  if (!item || !Detail) return <InboxStale type={type} id={id} />;
  const time = itemTime(item);
  const context = () => {
    const url = new URL(item.link, window.location.origin);
    navigate(readRoute(url));
  };
  return (
    <article className="inbox-detail" aria-label={kindLabel(item)}>
      <header className="inbox-detail-head">
        <span className={`inbox-row-icon ${item.type}`} aria-hidden="true">
          <Icon name={itemIcon(item)} size={18} />
        </span>
        <div>
          <h2>{kindLabel(item)}</h2>
          <p>{itemContext(item)}</p>
          <small className={`inbox-row-time${time.urgent ? " urgent" : ""}`}>
            {time.text}
          </small>
        </div>
        <button type="button" className="button secondary" onClick={context}>
          {copy.openContext}
          <Icon name="arrow" size={14} />
        </button>
      </header>
      <Detail item={item} navigate={navigate} done={reload} />
    </article>
  );
}
