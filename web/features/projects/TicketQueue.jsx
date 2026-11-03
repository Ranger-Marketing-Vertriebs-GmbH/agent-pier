import React, { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { ticketQueueCopy as copy } from "../../lib/i18n/messages/ticket-sequences.js";
import { ticketRulesCopy } from "../../lib/i18n/messages/ticket-rules.js";
import { ticketErrorCopy } from "../../lib/i18n/messages/tickets.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import { pipelineRunRoute } from "./routes.js";
import { queueItemActions, queueItemPath, queueStateTone } from "./ticket-queue.js";

const reasonText = (reason) =>
  (Object.hasOwn(copy.reasons, reason) && copy.reasons[reason]) || copy.reasons.other;
const codeText = (code) =>
  (Object.hasOwn(ticketErrorCopy, code) && ticketErrorCopy[code]) ||
  ticketErrorCopy.invalidResponse;
// The server refused Mark done or Remove because GitHub could not be read.
const unreadable = (error) =>
  error?.status === 409 && error.messageKey === "tickets.prUnreadable";

const queueKey = (items) => items.map((item) => `${item.id}:${item.state}`).join(",");

/** The detail line of an item: why it waits, its PR, or what a "done" left open. */
function itemSub(item) {
  if (item.state === "needs-owner") return reasonText(item.needsOwner?.reason);
  if (item.state !== "done")
    return item.pr?.number ? copy.pullRequest(item.pr.number) : "";
  return [
    item.writeBack?.state === "failed"
      ? copy.doneWriteBackFailed(codeText(item.writeBack.code))
      : "",
    item.prUnchecked && item.pr?.number ? copy.prUnchecked(item.pr.number) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// The rule an item came from, once the rules are known; nothing for a manual start.
function originText(item, rules) {
  if (item.origin?.kind !== "rule" || !rules) return "";
  const rule = rules.find((entry) => entry.id === item.origin.ruleId);
  return rule ? ticketRulesCopy.fromRule(rule.label) : ticketRulesCopy.fromDeletedRule;
}

function QueueRow({ item, rules, busy, onAction }) {
  const menu = useRowMenu();
  const labels = {
    retry: copy.retry,
    done: copy.markDone,
    remove: copy.remove,
    "open-session": copy.openSession,
    "open-repair": copy.openRepairSession,
    "open-run": copy.openRun,
    "open-pr": copy.openPullRequest,
  };
  const items = queueItemActions(item).map((action) => ({
    id: action,
    label: labels[action],
    run: () => onAction(item, action),
  }));
  const sub = [originText(item, rules), itemSub(item)].filter(Boolean).join(" · ");
  return (
    <div className="row-menu-anchor">
      <ListRow
        label={`${item.key} ${item.title || ""}`.trim()}
        sub={sub}
        disabled={busy}
        menu={
          items.length
            ? {
                label: copy.rowActions(item.key),
                expanded: menu.open,
                onClick: menu.toggle,
              }
            : undefined
        }
      >
        <span className="project-ticket-chip">
          <StatusChip tone={queueStateTone(item.state)}>
            {copy.states[item.state] || item.state}
          </StatusChip>
        </span>
      </ListRow>
      <RowMenu label={copy.rowActions(item.key)} state={menu} items={items} />
    </div>
  );
}

/**
 * The project's ticket sequence (the `tickets.queue` topic's `view`): one row per
 * item with its state, the reason a parked item waits for the owner, and the owner
 * actions. Retry runs at once; Mark done and Remove ask first, and ask once more when
 * GitHub cannot be read (the PR may stay armed). `written` is the topic's, so an action
 * stays busy until the pushed change shows.
 */
export default function TicketQueue({ projectId, view, written, rules, onNavigate }) {
  const items = view?.queue?.items || [];
  const action = useAsyncAction();
  const [confirming, setConfirming] = useState(null);
  // A note after a forced Remove; it lasts until the queue changes or is dismissed.
  const [notice, setNotice] = useState(null);
  const noticeText = notice && notice.queue === queueKey(items) ? notice.text : "";
  const send = async (item, name, force = false) => {
    const query = force ? "?force=true" : "";
    const result = await (name === "remove"
      ? api(`${queueItemPath(projectId, item.id)}${query}`, "DELETE")
      : api(`${queueItemPath(projectId, item.id, name)}${query}`, "POST"));
    await written?.();
    return result;
  };
  const confirm = async () => {
    const { item, name, force } = confirming;
    let result;
    try {
      result = await send(item, name, force);
    } catch (error) {
      // GitHub could not be read: the dialog asks once more, naming the risk.
      if (unreadable(error) && !force)
        return setConfirming({ ...confirming, force: true });
      throw error;
    }
    if (result?.unchecked?.pr?.number)
      setNotice({
        text: copy.removedUnchecked(result.unchecked.key, result.unchecked.pr.number),
        // The queue the Remove left; any later change of it clears the note.
        queue: queueKey(result.queue?.items || []),
      });
    setConfirming(null);
  };
  const onAction = (item, name) => {
    if (name === "open-session")
      onNavigate({ view: "workspace", sessionId: item.sessionId });
    else if (name === "open-repair")
      onNavigate({ view: "workspace", sessionId: item.repair.sessionId });
    else if (name === "open-run") onNavigate(pipelineRunRoute(item.runId));
    else if (name === "open-pr")
      window.open(item.pr.url, "_blank", "noopener,noreferrer");
    else if (name === "retry") action.run(() => send(item, "retry"));
    else setConfirming({ item, name });
  };
  if (!items.length && !noticeText) return null;
  return (
    <section className="project-ticket-queue">
      <GroupLabel id="project-ticket-queue-heading">{copy.title}</GroupLabel>
      <ListCard labelledBy="project-ticket-queue-heading">
        {items.map((item) => (
          <QueueRow
            key={item.id}
            item={item}
            rules={rules}
            busy={action.busy}
            onAction={onAction}
          />
        ))}
      </ListCard>
      <ErrorMessage error={action.error} />
      {noticeText && (
        <div className="project-ticket-queue-notice">
          <ErrorMessage error={noticeText} />
          <button
            type="button"
            className="button secondary"
            onClick={() => setNotice(null)}
          >
            {commonCopy.close}
          </button>
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title={
            confirming.name === "remove"
              ? copy.removeTitle(confirming.item.key)
              : copy.doneTitle(confirming.item.key)
          }
          body={
            confirming.force
              ? copy.unreadableBody(confirming.item.pr?.number)
              : confirming.name === "remove"
                ? copy.removeBody
                : copy.doneBody
          }
          confirmLabel={
            confirming.force
              ? copy.confirmAnyway
              : confirming.name === "remove"
                ? commonCopy.remove
                : copy.markDone
          }
          focusCancel={!!confirming.force}
          onCancel={() => setConfirming(null)}
          onConfirm={confirm}
        />
      )}
    </section>
  );
}
