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

/** Why a find stays in the CLI; environment references name where they are used. */
function notAdoptableText(find) {
  if (find.reason === "env-references")
    return copy.envReferences((find.referenceNames || []).join(", "));
  return copy.notAdoptable[find.reason] || copy.notAdoptable.invalid;
}

/** One found entry: what it is, and Adopt (with a proposed name) or why it stays. */
function FindItem({ find, busy, name, rename, adopt }) {
  return (
    <li className="mcp-item">
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
                value={name}
                maxLength={30}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => rename(event.target.value)}
              />
            </label>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            aria-label={copy.adoptNamed(find.name)}
            onClick={() => adopt({ keys: [find.key], names: { [find.key]: name } })}
          >
            {copy.adopt}
          </button>
        </div>
      ) : (
        <p className="mcp-hint">{notAdoptableText(find)}</p>
      )}
    </li>
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
  // The parent's reload changes `refresh`, which loads the finds again: once.
  async function adopt(body) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await cliApi.adopt(body);
      const adopted = result.adopted.map((server) => server.name);
      setNotice(
        [
          ...(adopted.length ? [copy.adopted(adopted.join(", "))] : []),
          ...result.failed.map((item) =>
            copy.adoptFailed(item.name || item.key, serverProblemText(item, item.error)),
          ),
        ].join(" "),
      );
      await onAdopted();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const adoptable = (finds || []).filter((find) => find.adoptable);
  // Heading and intro stay while the finds load and after a failed load.
  return (
    <section className="mcp-cli-finds" aria-labelledby={titleId}>
      <h3 id={titleId}>{copy.foundTitle}</h3>
      <p className="mcp-hint">{copy.foundHint}</p>
      <ErrorMessage error={error} />
      {!finds && !error && <p className="mcp-hint">{copy.foundLoading}</p>}
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
      {finds && !finds.length && <p className="mcp-hint">{copy.foundNone}</p>}
      {finds && (
        <ul className="mcp-list">
          {finds.map((find) => (
            <FindItem
              key={find.key}
              find={find}
              busy={busy}
              name={nameOf(find)}
              rename={(value) =>
                setRenamed((current) => ({ ...current, [find.key]: value }))
              }
              adopt={adopt}
            />
          ))}
        </ul>
      )}
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
