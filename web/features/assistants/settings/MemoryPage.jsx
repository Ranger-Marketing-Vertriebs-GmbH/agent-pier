import React, { useEffect, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantApi } from "../assistant-api.js";
import { memoryStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import ConflictNotice from "./ConflictNotice.jsx";
import SubpageHeader from "./SubpageHeader.jsx";

/**
 * The agent's two root notes (editable, saved against the loaded hash) and its own
 * notes under memory/ (read only), plus a search over all of them. `readOnly` (a
 * user's own agent under her opt-in) shows every note read only.
 */
export default function MemoryPage({ assistant, onBack, readOnly: locked = false }) {
  const copy = assistantCopy.personal;
  const assistantId = assistant.id;
  const [name, setName] = useState("MEMORY.md"),
    [file, setFile] = useState(null),
    [notes, setNotes] = useState([]),
    [nextName, setNextName] = useState(null);
  const [query, setQuery] = useState(""),
    [results, setResults] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
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
  useEffect(() => {
    let active = true;
    setFile(null);
    setError("");
    assistantApi
      .memory(assistantId, name)
      .then((next) => active && setFile(next))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [assistantId, name, reload]);
  const readOnly = locked || Boolean(file?.readOnly);
  const savable = Boolean(file) && !readOnly && Boolean(file.missing || file.hash);
  const draft = useTabDraft({ server: { content: file?.content ?? "" } });
  const steps = savable
    ? [memoryStep({ assistantId, name, file, label: copy.memory })]
    : [];
  const save = async () => {
    const result = await draft.save(steps);
    if (result.status === "saved" && result.results.memory)
      setFile(result.results.memory);
    // Changed elsewhere (409 "assistants.conflict"): read the note's current hash and
    // content without touching the draft, so "Reload" shows the newer note and
    // "Overwrite anyway" saves against the newer hash instead of failing again.
    if (result.status === "conflict")
      assistantApi.memory(assistantId, name).then(
        (next) => setFile(next),
        () => {},
      );
    return result;
  };
  const sheet = useAgentDraftGuard({
    draft,
    assistantId,
    tab: "capabilities",
    page: "memory",
    label: copy.memory,
    save,
  });
  // Another note is not a route change: this page asks itself before switching.
  const choose = (next) => (draft.dirty ? setNextName(next) : setName(next));
  const switchTo = () => {
    setName(nextName);
    setNextName(null);
  };
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
    <section className="agent-subpage" aria-label={copy.memory}>
      <SubpageHeader title={copy.memory} tab="capabilities" onBack={onBack} />
      <ErrorMessage error={error} />
      <ConflictNotice draft={draft} labels={{ content: () => copy.notes }} />
      <div className="list-card agent-fields">
        <label className="agent-field">
          {copy.noteType}
          <select
            value={name}
            disabled={busy || draft.saving}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="MEMORY.md">{copy.facts}</option>
            <option value="USER.md">{copy.preferences}</option>
            {notes.length > 0 && (
              <optgroup label={copy.agentNotes}>
                {notes.map((note) => (
                  <option key={note.name} value={note.name}>
                    {note.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className="agent-field">
          {copy.notes}
          <textarea
            rows={9}
            maxLength={65536}
            disabled={!file || busy || (!savable && !readOnly)}
            readOnly={readOnly}
            value={file ? draft.values.content : ""}
            onChange={(event) => draft.set("content", event.target.value)}
          />
        </label>
      </div>
      {readOnly && !locked && <p className="assistant-note">{copy.agentNotesHint}</p>}
      <div className="assistant-actions">
        {!readOnly && (
          <button
            type="button"
            className="button secondary"
            disabled={!savable || busy}
            onClick={() => draft.set("content", "")}
          >
            {copy.clearNotes}
          </button>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => {
            draft.reset();
            setReload((n) => n + 1);
          }}
        >
          {copy.reload}
        </button>
      </div>
      {!locked && <p className="assistant-note">{copy.clearHint}</p>}
      <form className="list-card agent-fields" onSubmit={search}>
        <label className="agent-field">
          {copy.searchMemory}
          <input
            required
            maxLength={1000}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="agent-field">
          <button className="button secondary" disabled={busy}>
            {copy.search}
          </button>
        </div>
      </form>
      {results?.length === 0 && <p className="assistant-note">{copy.noResults}</p>}
      {results?.map((result, index) => (
        <article className="assistant-card" key={`${result.path}-${index}`}>
          <strong>{result.path}</strong>
          <p className="assistant-memory-text">{result.snippet}</p>
        </article>
      ))}
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={save}
        saveLabel={copy.saveNotes}
      />
      <UnsavedChangesSheet {...sheet} />
      <UnsavedChangesSheet
        open={nextName !== null}
        tab={copy.memory}
        count={draft.changeCount}
        busy={draft.saving}
        onSave={async () => {
          if ((await save()).status === "saved") switchTo();
          else setNextName(null);
        }}
        onDiscard={() => {
          draft.reset();
          switchTo();
        }}
        onCancel={() => setNextName(null)}
      />
    </section>
  );
}
