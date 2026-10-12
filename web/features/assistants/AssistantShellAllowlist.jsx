import React, { useCallback, useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { assistantShellCopy as copy } from "../../lib/i18n/messages/assistant-shell.js";
import { assistantApi } from "./assistant-api.js";

/**
 * The commands this agent may always run (OpenClaw's exec allowlist). A path
 * entry's linked command entries are folded into it by the server and deleted
 * with it; an exact command entry the server cannot place is listed on its own.
 */
export default function AssistantShellAllowlist({ assistantId }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
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
    <div className="assistant-shell-allowlist">
      <h3>{copy.allowlist}</h3>
      <p className="assistant-note">{copy.allowlistHint}</p>
      <ErrorMessage error={error} />
      {entries === null && !error && (
        <p className="assistant-note">{copy.allowlistLoading}</p>
      )}
      {entries?.length === 0 && <p className="assistant-note">{copy.allowlistEmpty}</p>}
      {entries?.length > 0 && (
        <ul>
          {entries.map((entry) => (
            <li key={entry.id} className="assistant-shell-entry">
              <div>
                <code>
                  {entry.kind === "command" ? copy.commandEntry : entry.pattern}
                </code>
                <small>
                  {copy.sources[entry.source] || copy.sources.other}
                  {entry.kind === "program" &&
                    ` · ${entry.argPattern ? copy.exactArguments : copy.anyArguments}`}
                </small>
                {(entry.command || entry.lastUsedCommand) && (
                  <small>
                    {copy.command}: <code>{entry.command || entry.lastUsedCommand}</code>
                  </small>
                )}
                {entry.cwd && (
                  <small>
                    {copy.folder}: <code>{entry.cwd}</code>
                  </small>
                )}
                {entry.lastUsedAt && (
                  <small>{copy.lastUsed(formatTimestamp(entry.lastUsedAt))}</small>
                )}
                {entry.companions?.length > 0 && (
                  <small>{copy.linked(entry.companions.length)}</small>
                )}
              </div>
              <button
                type="button"
                className="button secondary"
                disabled={!!busy}
                aria-label={copy.removeLabel(
                  entry.kind === "command" ? copy.commandEntry : entry.pattern,
                )}
                onClick={() => remove(entry)}
              >
                {copy.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
