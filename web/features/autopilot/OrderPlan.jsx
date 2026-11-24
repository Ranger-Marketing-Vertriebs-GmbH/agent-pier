import React from "react";
import ActivityRow from "../../components/ActivityRow.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import { autopilotDashboardCopy as copy } from "../../lib/i18n/messages/autopilot-dashboard.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import OrderSources from "./OrderSources.jsx";
import {
  dependencyTitles,
  planTitles,
  statusBreakdown,
  statusText,
  statusTone,
} from "./order-presentation.js";

export function ProgressNotes({ entry }) {
  const notes = ["checkpoint", "nextAction"].filter((key) => entry[key]);
  return notes.length ? (
    <dl className="order-progress-notes">
      {notes.map((key) => (
        <div key={key}>
          <dt>{copy[key]}</dt>
          <dd>{entry[key]}</dd>
        </div>
      ))}
    </dl>
  ) : null;
}

function EntryBody({ entry, titles, navigate }) {
  return (
    <>
      {entry.task && <p className="order-text">{entry.task}</p>}
      {entry.dependsOn?.length > 0 && (
        <p className="order-dependencies">
          <strong>{copy.depends}</strong>{" "}
          {dependencyTitles(entry.dependsOn, titles).join(", ")}
        </p>
      )}
      <ProgressNotes entry={entry} />
      <OrderSources entry={entry} navigate={navigate} />
    </>
  );
}

function ItemList({ items, titles, navigate }) {
  return (
    <ol className="order-plan-list">
      {items.map((item, index) => (
        <li key={item.id ?? index} className="order-work-item">
          <div className="order-item-heading">
            <strong>{item.title || item.id || copy.item(index + 1)}</strong>
            <span>{statusText(item.status)}</span>
          </div>
          <EntryBody entry={item} titles={titles} navigate={navigate} />
        </li>
      ))}
    </ol>
  );
}

function BatchList({ entries, label, navigate, extraItems = [] }) {
  if (!entries?.length) return null;
  const titles = planTitles([...entries, ...extraItems]);
  return (
    <section>
      <GroupLabel as="h3">{label}</GroupLabel>
      <ol className="order-plan-list" aria-label={label}>
        {entries.map((entry, index) => (
          <li key={entry.id ?? index}>
            <ActivityRow
              icon="folder"
              label={copy.batch(index + 1, entry.title || entry.id)}
              status={statusText(entry.status)}
              tone={statusTone(entry.status)}
              detail={entry.counts?.total > 0 ? copy.itemCount(entry.counts.total) : null}
            >
              <EntryBody entry={entry} titles={titles} navigate={navigate} />
              {entry.items?.length > 0 && (
                <>
                  <p className="order-item-counts">{statusBreakdown(entry.counts)}</p>
                  <ItemList items={entry.items} titles={titles} navigate={navigate} />
                </>
              )}
            </ActivityRow>
          </li>
        ))}
      </ol>
    </section>
  );
}

// The API counts approved work. A draft-only order has a separate proposed total.
function countsOf(entries) {
  const counts = { total: entries.length, byStatus: Object.create(null) };
  for (const entry of entries) {
    const code = entry.status || "unknown";
    counts.byStatus[code] = (counts.byStatus[code] ?? 0) + 1;
  }
  return counts;
}

function PlanTotals({ order }) {
  if (
    order.limitations?.some((code) =>
      [
        "identityMismatch",
        "projectUnavailable",
        "missingFile",
        "unreadableFile",
      ].includes(code),
    )
  )
    return null;
  const draft = !order.batches?.length && order.draftBatches?.length;
  const totals = {
    batchCount: draft ? countsOf(order.draftBatches) : order.counts?.batches,
    items: draft
      ? countsOf(order.draftBatches.flatMap((batch) => batch.items ?? []))
      : order.counts?.items,
    tickets: order.counts?.tickets,
    runs: order.counts?.runs,
  };
  return (
    <dl className="order-plan-totals">
      {Object.entries(totals).map(([key, counts]) => (
        <div key={key}>
          <dt>{copy[key]}</dt>
          <dd>
            <strong>{counts?.total ?? commonCopy.unknown}</strong>
            <small>{statusBreakdown(counts)}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function OrderPlan({ order, navigate }) {
  const empty = ![order.batches, order.draftBatches, order.items, order.topics].some(
    (entries) => entries?.length,
  );
  return (
    <section className="order-plan" aria-label={copy.plan}>
      <header className="order-plan-heading">
        <h2>{copy.plan}</h2>
        <span>{copy.planState(statusText(order.planStatus))}</span>
      </header>
      <PlanTotals order={order} />
      {empty && <p className="order-empty-plan">{copy.emptyPlan}</p>}
      <BatchList
        entries={order.batches}
        label={copy.approved}
        navigate={navigate}
        extraItems={order.items}
      />
      <BatchList entries={order.draftBatches} label={copy.draft} navigate={navigate} />
      <BatchList
        entries={order.topics}
        label={copy.topics}
        navigate={navigate}
        extraItems={order.items}
      />
      {order.items?.length > 0 && (
        <section>
          <GroupLabel as="h3">{copy.unassigned}</GroupLabel>
          <ItemList
            items={order.items}
            titles={planTitles([
              ...order.items,
              ...(order.topics ?? []),
              ...(order.batches ?? []),
            ])}
            navigate={navigate}
          />
        </section>
      )}
    </section>
  );
}
