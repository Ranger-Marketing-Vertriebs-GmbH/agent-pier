import React, { useEffect, useState } from "react";
import { assistantApi } from "./assistant-api.js";
import { assistantCopy as messages } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
export default function AssistantMemory({ assistantId }) {
  const copy = messages.personal;
  const [name, setName] = useState("MEMORY.md"),
    [file, setFile] = useState(null),
    [content, setContent] = useState("");
  const [query, setQuery] = useState(""),
    [results, setResults] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0),
    [notes, setNotes] = useState([]);
  // Notes the agent writes under memory/ are listed for reading; only the two
  // root files are edited here.
  useEffect(() => {
    let active = true;
    assistantApi
      .memoryFiles(assistantId)
      .then((next) => active && setNotes(Array.isArray(next?.files) ? next.files : []))
      .catch(() => active && setNotes([]));
    return () => {
      active = false;
    };
  }, [assistantId, reload]);
  const readOnly = !!file?.readOnly;
  useEffect(() => {
    let active = true;
    setFile(null);
    setError("");
    assistantApi
      .memory(assistantId, name)
      .then((next) => {
        if (active) {
          setFile(next);
          setContent(next.content);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [assistantId, name, reload]);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const next = await assistantApi.saveMemory(assistantId, {
        name,
        content,
        ...(file.missing ? { expectedMissing: true } : { expectedHash: file.hash }),
      });
      setFile(next);
      setContent(next.content);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function search(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setResults((await assistantApi.searchMemory(assistantId, query)).results);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="assistant-form assistant-personal-panel">
      <h2>{copy.memory}</h2>
      <p className="assistant-note">{copy.memoryHint}</p>
      <ErrorMessage error={error} />
      <form onSubmit={save}>
        <label>
          {copy.noteType}
          <select value={name} disabled={busy} onChange={(e) => setName(e.target.value)}>
            <option value="MEMORY.md">{copy.facts}</option>
            <option value="USER.md">{copy.preferences}</option>
            {notes.length > 0 && (
              <optgroup label={copy.agentNotes}>
                {notes.map((n) => (
                  <option key={n.name} value={n.name}>
                    {n.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label>
          {copy.notes}
          <textarea
            rows={7}
            maxLength={65536}
            disabled={!file || busy}
            readOnly={readOnly}
            value={file ? content : ""}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
        {readOnly && <p className="assistant-note">{copy.agentNotesHint}</p>}
        <div className="assistant-actions">
          {!readOnly && (
            <button
              className="button primary"
              disabled={!file || busy || (!file.missing && !file.hash)}
            >
              {copy.saveNotes}
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              className="button secondary"
              disabled={!file || busy}
              onClick={() => setContent("")}
            >
              {copy.clearNotes}
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => setReload((n) => n + 1)}
          >
            {copy.reload}
          </button>
        </div>
        <p className="assistant-note">{copy.clearHint}</p>
      </form>
      <form onSubmit={search}>
        <label>
          {copy.searchMemory}
          <input
            required
            maxLength={1000}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button className="button secondary" disabled={busy}>
          {copy.search}
        </button>
      </form>
      {results?.length === 0 && <p className="assistant-note">{copy.noResults}</p>}
      {results?.map((r, i) => (
        <article className="assistant-card" key={`${r.path}-${i}`}>
          <strong>{r.path}</strong>
          <p className="assistant-memory-text">{r.snippet}</p>
        </article>
      ))}
    </section>
  );
}
