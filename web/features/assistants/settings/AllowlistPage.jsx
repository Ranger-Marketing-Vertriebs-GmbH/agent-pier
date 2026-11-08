import React, { useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { formatTimestamp } from "../../../lib/i18n/index.js";
import useLiveTopic from "../../../lib/live/useLiveTopic.js";
import { assistantShellCopy as copy } from "../../../lib/i18n/messages/assistant-shell.js";
import { assistantApi } from "../assistant-api.js";
import { runtimeName } from "../runtime-capabilities.js";
import SubpageHeader from "./SubpageHeader.jsx";

const entryName = (entry) =>
  entry.kind === "command" ? copy.commandEntry : entry.pattern;
// What a delete names: an exact command by its text (shortened), so the entries of a
// runtime that lists only exact commands (Hermes) stay distinguishable.
const removalName = (entry) =>
  entry.kind === "command" && entry.command
    ? entry.command.length > 80
      ? `${entry.command.slice(0, 79)}…`
      : entry.command
    : entryName(entry);

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
      {entry.addedAt && (
        <span className="agent-entry-line">
          {copy.added(formatTimestamp(entry.addedAt))}
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
 * The commands this agent may always run: OpenClaw's exec allowlist and the exact
 * commands AgentPier remembers, or on a runtime without an allowlist (Hermes,
 * `exactOnly`) the remembered commands alone. A path entry's linked command entries
 * are folded into it by the server and deleted with it. The live topic
 * `agent.allowlist:<id>` pushes every decision and deletion.
 */
export default function AllowlistPage({ assistant, onBack }) {
  const assistantId = assistant.id;
  const topic = useLiveTopic(`agent.allowlist:${assistantId}`);
  const [failed, setFailed] = useState(""),
    [busy, setBusy] = useState(""),
    [removing, setRemoving] = useState(null);
  const entries = topic.data ? topic.data.entries || [] : null;
  const error = failed || topic.error;
  async function remove(entry) {
    setBusy(entry.id);
    setFailed("");
    try {
      await assistantApi.removeShellAllowlistEntry(assistantId, entry.id);
      // Read again rather than show the answer: a push that arrived meanwhile is newer.
      await topic.refresh();
    } catch (e) {
      setFailed(e.message);
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
      {topic.data?.exactOnly && (
        <p className="assistant-note">{copy.exactOnly(runtimeName(assistant))}</p>
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
              deleteLabel={copy.removeLabel(removalName(entry))}
            />
          ))}
        </ListCard>
      )}
      {removing && (
        <ConfirmDialog
          destructive
          title={copy.removeTitle(removalName(removing))}
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
