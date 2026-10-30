import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { formatMessageTime } from "../../lib/i18n/index.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { apiCopy } from "../../lib/i18n/messages/components.js";
import { readRoute } from "../../app/routes.js";

const copy = assistantCopy.updates;
const endpoint = "/assistant-runtime/updates";
const text = (value) => typeof value === "string" && value.length > 0;

/** Whether `item` is a blocker item this panel can show (runtime-update-blockers.js). */
export function validBlockerItem(item) {
  return (
    !!item &&
    typeof item === "object" &&
    ["id", "kind", "revision", "resolution", "link"].every((key) => text(item[key])) &&
    item.link.startsWith("/") &&
    (item.since === null || text(item.since)) &&
    (item.agent === null ||
      (typeof item.agent === "object" && typeof item.agent?.name === "string"))
  );
}
const kindText = (item) =>
  copy.itemKinds[item.kind] ? copy.itemKinds[item.kind] : copy.unknownBlocker;
const itemLabel = (item) => copy.itemLabel(kindText(item), item.agent?.name || "");
const sinceText = (item) => (item.since ? copy.since(formatMessageTime(item.since)) : "");
const resolutionText = (item) => copy.resolutions[item.resolution] || "";
/** A sign-in in progress is never cancelled for an update. */
export const blocksPause = (items) => items.some((i) => i.resolution === "none");

/**
 * The open work that blocked the last activation, each row opening the place where
 * it is resolved.
 */
export function BlockerList({ items, navigate }) {
  return (
    <ListCard label={copy.openWork}>
      {items.map((item) => (
        <ListRow
          key={item.id}
          label={itemLabel(item)}
          sub={sinceText(item)}
          href={item.link}
          onClick={
            navigate
              ? () => navigate(readRoute(new URL(item.link, window.location.origin)))
              : undefined
          }
        />
      ))}
    </ListCard>
  );
}

/**
 * "Pause agents and update": reads what blocks the update now, lists what will happen
 * to each item and activates with exactly those items and revisions. Anything new or
 * changed since is left alone by the server, which then reports what remains.
 */
export function PauseAndUpdate({ version, disabled, onDone }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return undefined;
    let current = true;
    setItems(null);
    setError("");
    api(`${endpoint}/blockers`)
      .then((data) => {
        if (!current) return;
        const list = Array.isArray(data?.items) ? data.items : null;
        if (!list || !list.every(validBlockerItem))
          throw Error(apiCopy.requestFailed(503));
        setItems(list);
      })
      .catch((e) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [open]);
  async function confirm() {
    try {
      await api(`${endpoint}/activate`, "POST", {
        resolveBlockers: true,
        items: items.map(({ id, revision }) => ({ id, revision })),
      });
      setOpen(false);
      await onDone("");
    } catch (e) {
      // What remains is listed on the page from the update status.
      setOpen(false);
      await onDone(e.message);
    }
  }
  const login = !!items && blocksPause(items);
  return (
    <>
      <button
        className="button secondary"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {copy.pause}
      </button>
      {open && (
        <ConfirmDialog
          title={copy.pauseTitle(version)}
          body={[copy.pauseBody, copy.pauseNoResume]}
          confirmLabel={copy.pauseConfirm}
          destructive
          confirmDisabled={!items || login}
          onCancel={() => setOpen(false)}
          onConfirm={confirm}
        >
          {!items && !error && <p role="status">{copy.pauseLoading}</p>}
          {items && !items.length && <p>{copy.pauseNothing}</p>}
          {!!items?.length && (
            <ListCard label={copy.openWork}>
              {items.map((item) => (
                <ListRow
                  key={item.id}
                  label={itemLabel(item)}
                  sub={[sinceText(item), resolutionText(item)]
                    .filter(Boolean)
                    .join(" · ")}
                />
              ))}
            </ListCard>
          )}
          {login && <p role="status">{copy.pauseLoginHint}</p>}
          <ErrorMessage error={error} />
        </ConfirmDialog>
      )}
    </>
  );
}
