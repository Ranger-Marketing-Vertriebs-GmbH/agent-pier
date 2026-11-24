import React from "react";
import Icon from "../../components/Icon.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import { isPlainClick } from "../../components/link-click.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { autopilotDashboardCopy as copy } from "../../lib/i18n/messages/autopilot-dashboard.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { kindLabel } from "../inbox/inbox-presentation.js";
import OrderPlan, { ProgressNotes } from "./OrderPlan.jsx";
import OrderSources, { sourceLink } from "./OrderSources.jsx";
import { joinFacts, statusText, statusTone } from "./order-presentation.js";
import "./order-dashboard.css";

function Decisions({ order, navigate }) {
  const decisions = [
    ...(order.requests ?? []).map((request) => ({
      ...request,
      type: request.kind === "question" ? "question" : "approval",
    })),
    ...(order.runs ?? [])
      .filter((run) => run.gate)
      .map((run) => ({
        ...run.gate,
        id: run.id,
        type: "gate",
        context: run.pipelineName || run.id,
      })),
  ];
  if (!decisions.length) return null;
  return (
    <section className="order-decisions">
      <GroupLabel>{copy.decisions}</GroupLabel>
      <ListCard label={copy.decisions}>
        {decisions.map((item) => (
          <ListRow
            key={`${item.type}:${item.id}`}
            label={item.title || kindLabel(item)}
            sub={joinFacts(item.title && kindLabel(item), item.context)}
            icon={<Icon name={item.type === "question" ? "help" : "shield"} size={16} />}
            {...sourceLink(item.link, navigate)}
          />
        ))}
      </ListCard>
    </section>
  );
}

function snapshotTime(time) {
  if (!time) return null;
  return Number.isFinite(Date.parse(time)) ? formatTimestamp(time) : time;
}

function OrderBrief({ order }) {
  const facts = [
    [copy.orderId, order.id],
    [copy.reported, statusText(order.reportedStatus)],
    [copy.lastCheck, snapshotTime(order.lastCheckedAt)],
    [copy.nextCheck, snapshotTime(order.nextCheckAt)],
    [copy.branch, order.branch],
    [copy.worktree, order.worktree],
    [
      commonCopy.profile,
      order.selection &&
        joinFacts(
          order.selection.tool,
          order.selection.accountId,
          order.selection.providerConnectionId,
          order.selection.providerModelId,
          order.selection.nativeModelId,
          order.selection.launchMode,
        ),
    ],
  ];
  return (
    <details className="order-brief">
      <summary>{copy.brief}</summary>
      <p className="order-text">{order.brief || copy.noBrief}</p>
      <dl className="order-brief-facts">
        {facts
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
    </details>
  );
}

export default function OrderDashboard({ order, navigate, controls }) {
  const composer = order.session?.link && sourceLink(order.session.link, navigate);
  return (
    <article className="order-dashboard" aria-label={order.title}>
      <div className="order-overview">
        <div className="order-state">
          {copy.orderState}
          <StatusChip tone={statusTone(order.state)} pill>
            {statusText(order.state)}
          </StatusChip>
        </div>
        {composer && (
          <a
            className="button secondary"
            href={composer.href}
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              composer.onClick();
            }}
          >
            <Icon name="chats" size={16} /> {copy.composer}
          </a>
        )}
      </div>
      <Decisions order={order} navigate={navigate} />
      <OrderPlan order={order} navigate={navigate} />
      <ProgressNotes entry={order} />
      <OrderSources entry={order} navigate={navigate} />
      {order.startReceipts?.length > 0 && (
        <section>
          <GroupLabel>{copy.pipelineStarts}</GroupLabel>
          <ListCard label={copy.pipelineStarts}>
            {order.startReceipts.map((receipt) => (
              <ListRow
                key={receipt.requestId}
                label={receipt.requestId}
                sub={receipt.runId}
                value={joinFacts(
                  receipt.confirmed ? copy.confirmed : copy.unconfirmed,
                  receipt.queueState && statusText(receipt.queueState),
                )}
              />
            ))}
          </ListCard>
        </section>
      )}
      <OrderBrief order={order} />
      {controls}
      {order.limitations?.length > 0 && (
        <section>
          <GroupLabel>{copy.limits}</GroupLabel>
          <ul className="order-limitations">
            {order.limitations.map((code) => (
              <li key={code}>
                {Object.hasOwn(copy.limitations, code) ? copy.limitations[code] : code}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
