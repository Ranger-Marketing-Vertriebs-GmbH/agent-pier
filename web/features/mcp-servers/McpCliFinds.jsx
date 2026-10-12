import React, { useCallback, useEffect, useId, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { mcpServerCopy as serverCopy } from "../../lib/i18n/messages/mcp-servers.js";
import { names } from "../../lib/providers.js";
import { serverProblemText } from "../../lib/server-messages.js";
import { cliApi } from "./cli-api.js";

const valueNames = (find) => [...(find.headerNames || []), ...(find.envNames || [])];

/** Where a found entry points: its address, or its command and the path adoption saves. */
function FindTarget({ find }) {
  if (find.url) return <code>{find.url}</code>;
  if (!find.command) return null;
  return (
    <p className="mcp-find-target">
      <code>{find.command}</code>
      {find.resolvedCommand === null ? (
        <span className="mcp-hint">{copy.commandMissing}</span>
      ) : (
        find.resolvedCommand &&
        find.resolvedCommand !== find.command && (
          <span className="mcp-hint">{copy.savedAs(find.resolvedCommand)}</span>
        )
      )}
    </p>
  );
}

/**
 * Entries the owner added to a CLI outside AgentPier, offered for adoption; never
 * adopted on their own. Shows names only. `refresh` changes whenever the list reloads.
 */
export default function McpCliFinds({ refresh, onAdopted }) {
  const titleId = useId();
  const [finds, setFinds] = useState(null);
  const [problems, setProblems] = useState([]);
  const [renamed, setRenamed] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      const result = await cliApi.finds();
      setFinds(result.finds || []);
      setProblems(result.problems || []);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, refresh]);
  const nameOf = (find) => renamed[find.key] ?? find.proposedName ?? find.name;
  async function adopt(body) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await cliApi.adopt(body);
      setNotice(
        result.failed
          .map((item) =>
            copy.adoptFailed(item.name || item.key, serverProblemText(item, item.error)),
          )
          .join(" "),
      );
      await load();
      await onAdopted();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!finds) return <ErrorMessage error={error} />;
  const adoptable = finds.filter((find) => find.adoptable);
  return (
    <section className="mcp-cli-finds" aria-labelledby={titleId}>
      <h3 id={titleId}>{copy.foundTitle}</h3>
      <p className="mcp-hint">{copy.foundHint}</p>
      <ErrorMessage error={error} />
      {problems.map((problem) => (
        <p key={problem.cli} className="mcp-hint mcp-find-problem">
          {copy.statusLine(
            names[problem.cli] || problem.cli,
            copy.reasons[problem.reason] || copy.reasons.failed,
          )}
        </p>
      ))}
      {notice && (
        <p role="status" className="mcp-hint">
          {notice}
        </p>
      )}
      {!finds.length && <p className="mcp-hint">{copy.foundNone}</p>}
      <ul className="mcp-list">
        {finds.map((find) => (
          <li key={find.key} className="mcp-item">
            <div className="mcp-item-head">
              <strong>{find.name}</strong>
              {find.transport && (
                <span className="mcp-badge">{serverCopy.transports[find.transport]}</span>
              )}
              {find.transport === "stdio" && (
                <span className="mcp-badge mcp-badge-warn">{serverCopy.stdioBadge}</span>
              )}
              <span className="mcp-hint">
                {copy.foundIn(find.clis.map((cli) => names[cli] || cli).join(", "))}
              </span>
            </div>
            <FindTarget find={find} />
            {valueNames(find).length > 0 && (
              <p className="mcp-hint">{copy.valueNames(valueNames(find).join(", "))}</p>
            )}
            {find.adoptable ? (
              <div className="mcp-actions mcp-find-actions">
                {find.proposedName && (
                  <label className="mcp-find-name">
                    {copy.proposedName}
                    <input
                      value={nameOf(find)}
                      maxLength={30}
                      autoCapitalize="none"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                      onChange={(event) =>
                        setRenamed((current) => ({
                          ...current,
                          [find.key]: event.target.value,
                        }))
                      }
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  aria-label={copy.adoptNamed(find.name)}
                  onClick={() =>
                    adopt({ keys: [find.key], names: { [find.key]: nameOf(find) } })
                  }
                >
                  {copy.adopt}
                </button>
              </div>
            ) : (
              <p className="mcp-hint">
                {copy.notAdoptable[find.reason] || copy.notAdoptable.invalid}
              </p>
            )}
          </li>
        ))}
      </ul>
      {adoptable.length > 1 && (
        <div className="mcp-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() =>
              adopt({
                all: true,
                names: Object.fromEntries(
                  adoptable.map((find) => [find.key, nameOf(find)]),
                ),
              })
            }
          >
            {copy.adoptAll}
          </button>
        </div>
      )}
    </section>
  );
}
