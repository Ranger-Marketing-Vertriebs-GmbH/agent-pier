import React, { useCallback, useEffect, useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { formatTimestamp } from "../../../lib/i18n/index.js";
import { assistantShellCopy as copy } from "../../../lib/i18n/messages/assistant-shell.js";
import { assistantApi } from "../assistant-api.js";
import SubpageHeader from "./SubpageHeader.jsx";

const entryName = (entry) =>
  entry.kind === "command" ? copy.commandEntry : entry.pattern;

function EntryDetails({ entry }) {
  return (
    <>
      <span className="agent-entry-line">
        {copy.sources[entry.source] || copy.sources.other}
        {entry.kind === "program" &&
          ` · ${entry.argPattern ? copy.exactArguments : copy.anyArguments}`}
      </span>
      {(entry.command || entry.lastUsedCommand) && (
        <span className="agent-entry-line">
          {copy.command}: <code>{entry.command || entry.lastUsedCommand}</code>
        </span>
      )}
      {entry.cwd && (
        <span className="agent-entry-line">
          {copy.folder}: <code>{entry.cwd}</code>
        </span>
      )}
      {entry.lastUsedAt && (
        <span className="agent-entry-line">
          {copy.lastUsed(formatTimestamp(entry.lastUsedAt))}
        </span>
      )}
      {entry.companions?.length > 0 && (
        <span className="agent-entry-line">{copy.linked(entry.companions.length)}</span>
      )}
    </>
  );
}

/**
 * The commands this agent may always run (OpenClaw's exec allowlist). A path entry's
 * linked command entries are folded into it by the server and deleted with it.
 */
export default function AllowlistPage({ assistant, onBack }) {
  const assistantId = assistant.id;
  const [entries, setEntries] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [removing, setRemoving] = useState(null);
  const load = useCallback(async () => {
    try {
      const result = await assistantApi.shellAllowlist(assistantId);
      setEntries(result.entries || []);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [assistantId]);
  useEffect(() => {
    load();
  }, [load]);
  async function remove(entry) {
    setBusy(entry.id);
    setError("");
    try {
      const result = await assistantApi.removeShellAllowlistEntry(assistantId, entry.id);
      if (Array.isArray(result.entries)) setEntries(result.entries);
      else await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section id="agent-allowlist" className="agent-subpage" aria-label={copy.allowlist}>
      <SubpageHeader
        title={copy.allowlist}
        tab="capabilities"
        onBack={onBack}
        hint={copy.allowlistHint}
      />
      <ErrorMessage error={error} />
      {entries === null && !error && (
        <p className="assistant-note">{copy.allowlistLoading}</p>
      )}
      {entries?.length === 0 && <p className="assistant-note">{copy.allowlistEmpty}</p>}
      {entries?.length > 0 && (
        <ListCard label={copy.allowlist}>
          {entries.map((entry) => (
            <ListRow
              key={entry.id}
              className="assistant-shell-entry"
              label={<code>{entryName(entry)}</code>}
              sub={<EntryDetails entry={entry} />}
              disabled={Boolean(busy)}
              onDelete={() => setRemoving(entry)}
              deleteLabel={copy.removeLabel(entryName(entry))}
            />
          ))}
        </ListCard>
      )}
      {removing && (
        <ConfirmDialog
          destructive
          title={copy.removeTitle(entryName(removing))}
          body={copy.removeBody}
          confirmLabel={copy.removeNow}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            setRemoving(null);
            return remove(removing);
          }}
        />
      )}
    </section>
  );
}
