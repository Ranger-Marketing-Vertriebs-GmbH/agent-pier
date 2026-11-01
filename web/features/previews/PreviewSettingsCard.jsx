import React, { useEffect, useState } from "react";
import CodeBlock from "../../components/CodeBlock.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { NumberRow, ToggleRow } from "../../components/ListRow.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { previewCopy as copy } from "../../lib/i18n/messages/previews.js";
import PreviewRows from "./PreviewRows.jsx";
import usePreviews from "./usePreviews.js";
import "./previews.css";

const same = (a, b) =>
  a.enabled === b.enabled &&
  a.portRangeStart === b.portRangeStart &&
  a.portRangeEnd === b.portRangeEnd;

const slotRow = ({ state }) =>
  state === "preview"
    ? { value: copy.slotPreview }
    : state === "free"
      ? { status: { tone: "ok", text: copy.slotFree } }
      : { status: { tone: "warn", text: copy.slotTaken } };

/**
 * The Tailscale Serve state of the range: shared, skipped in network mode, or the ports
 * it could not share with the exact commands to run by hand.
 */
function ServeState({ serve }) {
  const failed = serve.failed || [];
  const occupied = failed.filter((entry) => entry.reason === "occupied");
  const refused = failed.filter((entry) => entry.reason !== "occupied");
  const list = (entries) => entries.map((entry) => entry.port).join(", ");
  let row = {
    status: { tone: "ok", text: copy.serveRegistered(serve.registered.length) },
  };
  if (serve.skipped) row = { sub: copy.serveNetwork };
  else if (failed.length)
    row = { status: { tone: "warn", text: copy.serveFailed(list(failed)) } };
  return (
    <>
      <ListCard label={copy.serveTitle}>
        <ListRow label={copy.serveTitle} {...row} />
      </ListCard>
      {occupied.length > 0 && <p>{copy.serveOccupied(list(occupied))}</p>}
      {refused.length > 0 && serve.commands?.length > 0 && (
        <>
          <p>{copy.serveCommandsHint}</p>
          {refused.map((entry) => (
            <p key={entry.port}>
              {copy.port(entry.port)}: <code>{entry.reason}</code>
            </p>
          ))}
          <CodeBlock copyLabel={copy.serveCopy}>{serve.commands.join("\n")}</CodeBlock>
        </>
      )}
    </>
  );
}

/**
 * Settings › Remote access › Previews: the switch, the port range, the state of each
 * port and the open previews with Stop. `locked`: the request arrives over plain
 * network access, which may only switch previews off.
 */
export default function PreviewSettingsCard({ locked = false }) {
  const { data, written } = usePreviews();
  const action = useAsyncAction();
  const [draft, setDraft] = useState(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (data?.settings && !draft) setDraft(data.settings);
  }, [data, draft]);
  if (!data?.settings || !draft)
    return (
      <article className="settings-card preview-settings">
        <h2>{copy.title}</h2>
        <p role="status">{copy.loading}</p>
      </article>
    );
  const edit = (change) => {
    setNotice("");
    setDraft({ ...draft, ...change });
  };
  const complete =
    Number.isInteger(draft.portRangeStart) && Number.isInteger(draft.portRangeEnd);
  const save = () =>
    action.run(async () => {
      const result = await api("/previews/settings", "PUT", {
        enabled: draft.enabled,
        portRangeStart: draft.portRangeStart,
        portRangeEnd: draft.portRangeEnd,
      });
      setDraft(result.settings);
      setNotice(copy.saved);
      await written();
    });
  const busy = action.busy;
  return (
    <article className="settings-card preview-settings">
      <h2>{copy.title}</h2>
      <p>{copy.description}</p>
      <ListCard label={copy.title}>
        <ToggleRow
          label={copy.enable}
          sub={copy.enableSub}
          checked={draft.enabled}
          disabled={busy || (locked && !draft.enabled)}
          onChange={(enabled) => edit({ enabled })}
        />
        <NumberRow
          label={copy.rangeStart}
          sub={copy.rangeSub}
          value={draft.portRangeStart}
          min={1024}
          max={65535}
          disabled={busy || locked}
          onChange={(portRangeStart) => edit({ portRangeStart })}
        />
        <NumberRow
          label={copy.rangeEnd}
          value={draft.portRangeEnd}
          min={1024}
          max={65535}
          disabled={busy || locked}
          onChange={(portRangeEnd) => edit({ portRangeEnd })}
        />
      </ListCard>
      {locked && <p role="status">{copy.locked}</p>}
      {data.settings.enabled && (
        <ListCard label={copy.portsTitle}>
          {(data.slots || []).map((slot) => (
            <ListRow key={slot.port} label={copy.port(slot.port)} {...slotRow(slot)} />
          ))}
        </ListCard>
      )}
      {data.settings.enabled && data.serve && <ServeState serve={data.serve} />}
      {data.previews?.length > 0 && (
        <PreviewRows
          previews={data.previews}
          label={copy.activeTitle}
          onStop={() => written()}
        />
      )}
      <ErrorMessage error={action.error} />
      {notice && <p role="status">{notice}</p>}
      <div className="operations-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy || !complete || same(draft, data.settings)}
          onClick={save}
        >
          {commonCopy.save}
        </button>
      </div>
    </article>
  );
}
