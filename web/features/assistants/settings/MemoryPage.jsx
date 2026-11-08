import React, { useCallback, useEffect, useRef, useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantDreamingCopy as dreamingCopy } from "../../../lib/i18n/messages/assistant-dreaming.js";
import { formatBytes } from "../../../lib/format-bytes.js";
import { locale } from "../../../lib/i18n/index.js";
import useLiveTopic from "../../../lib/live/useLiveTopic.js";
import { assistantApi } from "../assistant-api.js";
import { memoryStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import useMemoryNotes from "./useMemoryNotes.js";
import { lineRange, openableNote } from "./memory-match.js";
import { diaryText } from "./dream-diary.js";
import MemoryPins from "./MemoryPins.jsx";
import ConflictNotice from "./ConflictNotice.jsx";
import MemoryArchiveList from "./MemoryArchiveList.jsx";
import SubpageHeader from "./SubpageHeader.jsx";

/**
 * The agent's two root notes and its day notes under memory/ (editable, saved against
 * the loaded hash; a day note can also be deleted), its Dream Diary (read only), plus
 * a search over all of them whose results open their note at the match, and the
 * archive of entries taken out after a model switch (MemoryArchiveList). A Hermes
 * agent's MEMORY.md and USER.md (their read names a `limit`) list their entries with a
 * pin each (MemoryPins). `readOnly` (a user's own agent under her opt-in) shows every
 * note read only.
 */
export default function MemoryPage({ assistant, onBack, readOnly: locked = false }) {
  const copy = assistantCopy.personal;
  const assistantId = assistant.id;
  const [name, setName] = useState("MEMORY.md"),
    [file, setFile] = useState(null),
    [nextName, setNextName] = useState(null);
  const [query, setQuery] = useState(""),
    [results, setResults] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0),
    // Pushes of agent.memory: the listing is read again, the shown note when clean.
    [pushes, setPushes] = useState(0),
    [refresh, setRefresh] = useState(0),
    [deleting, setDeleting] = useState(false),
    // A search result being opened: its note and lines, selected once it loaded.
    [match, setMatch] = useState(null);
  const textarea = useRef(null);
  const fetchNotes = useCallback(
    (offset) => assistantApi.memoryFiles(assistantId, offset),
    [assistantId],
  );
  const listing = useMemoryNotes(fetchNotes, `${reload}:${pushes}`);
  const notes = listing.notes || [];
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
  // A pushed listing (a Hermes night was recorded, which also rewrote MEMORY.md and
  // USER.md): the shown note is read again in place, unless the owner is editing it.
  // An OpenClaw agent's topic does not push; its listing is read when the page opens.
  const shownName = useRef(name);
  shownName.current = name;
  useEffect(() => {
    if (!refresh) return undefined;
    let active = true;
    const wanted = shownName.current;
    assistantApi.memory(assistantId, wanted).then(
      (next) => active && shownName.current === wanted && setFile(next),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [assistantId, refresh]);
  const diaries = notes.filter((note) => note.diary);
  const agentNotes = notes.filter((note) => !note.diary);
  const diary = diaries.some((note) => note.name === name);
  // A day note under memory/ is rewritten (and deleted) by the owner; a user's own
  // agent under her opt-in (`locked`) and the diary stay read only.
  const editable = !locked && !diary && file?.editable === true;
  const readOnly = locked || diary || (Boolean(file?.readOnly) && !editable);
  const savable = Boolean(file) && !readOnly && Boolean(file.missing || file.hash);
  const loaded = file ? diaryText(file, dreamingCopy) : "";
  const draft = useTabDraft({ server: { content: loaded } });
  const topic = useLiveTopic(`agent.memory:${assistantId}`);
  const seen = useRef(null);
  const dirty = useRef(false);
  dirty.current = draft.dirty;
  useEffect(() => {
    if (!topic.data) return;
    const value = JSON.stringify(topic.data);
    // The first value is the listing the page has just read.
    const first = seen.current === null;
    if (value === seen.current) return;
    seen.current = value;
    if (first) return;
    setPushes((n) => n + 1);
    if (!dirty.current) setRefresh((n) => n + 1);
  }, [topic.data]);
  const steps = savable
    ? [memoryStep({ assistantId, name, file, label: copy.memory })]
    : [];
  // The opened result's lines are selected and scrolled into view in its note.
  const shown = file ? draft.values.content : "";
  useEffect(() => {
    const field = textarea.current;
    if (!match || file?.name !== match.name || !field) return;
    // An untouched draft follows the loaded note one render later: wait for it.
    if (!draft.dirty && shown !== loaded) return;
    setMatch(null);
    const { start, end } = lineRange(field.value, match.startLine, match.endLine);
    field.focus();
    field.setSelectionRange(start, end);
    const lineHeight = parseFloat(getComputedStyle(field).lineHeight) || 20;
    field.scrollTop = Math.max(0, (match.startLine - 2) * lineHeight);
  }, [match, file, shown, loaded, draft.dirty]);
  const save = async () => {
    const result = await draft.save(steps);
    // A root note's save answers no limit: the one read stays.
    if (result.status === "saved" && result.results.memory)
      setFile(
        editable
          ? { ...file, ...result.results.memory, content: draft.values.content }
          : { limit: file.limit, ...result.results.memory },
      );
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
  const openResult = (result) => {
    setMatch({ name: result.path, startLine: result.startLine, endLine: result.endLine });
    if (result.path !== name) choose(result.path);
  };
  // A note opened from a search result that the list does not show (a later page).
  const unlisted =
    !["MEMORY.md", "USER.md"].includes(name) && !notes.some((note) => note.name === name);
  const switchTo = () => {
    setName(nextName);
    setNextName(null);
  };
  async function removeNote() {
    await assistantApi.removeMemoryNote(assistantId, name);
    draft.reset();
    setDeleting(false);
    setName("MEMORY.md");
    setReload((n) => n + 1);
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
            {diaries.map((note) => (
              <option key={note.name} value={note.name}>
                {dreamingCopy.diary}
              </option>
            ))}
            {(agentNotes.length > 0 || unlisted) && (
              <optgroup label={copy.agentNotes}>
                {unlisted && <option value={name}>{name}</option>}
                {agentNotes.map((note) => (
                  <option key={note.name} value={note.name}>
                    {note.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {listing.nextCount > 0 && (
          <div className="agent-field">
            <button
              type="button"
              className="button secondary compact"
              disabled={listing.loading}
              onClick={listing.loadMore}
            >
              {dreamingCopy.moreNotes(listing.nextCount)}
            </button>
          </div>
        )}
        <label className="agent-field">
          {copy.notes}
          <textarea
            ref={textarea}
            rows={9}
            maxLength={editable ? 262144 : 65536}
            disabled={!file || busy || (!savable && !readOnly)}
            readOnly={readOnly}
            value={shown}
            onChange={(event) => draft.set("content", event.target.value)}
          />
        </label>
      </div>
      {file?.limit > 0 && !diary && (
        <MemoryPins
          text={shown}
          limit={file.limit}
          readOnly={readOnly || busy || draft.saving}
          onChange={(content) => draft.set("content", content)}
        />
      )}
      {diary ? (
        <p className="assistant-note">
          {dreamingCopy.diaryHint}
          {file?.truncated &&
            ` ${dreamingCopy.diaryTruncated(formatBytes(file.size, locale))}`}
        </p>
      ) : (
        !locked &&
        (editable ? (
          <p className="assistant-note">{copy.editableNotesHint}</p>
        ) : (
          readOnly && <p className="assistant-note">{copy.agentNotesHint}</p>
        ))
      )}
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
        {editable && (
          <button
            type="button"
            className="button secondary"
            disabled={busy || draft.saving}
            onClick={() => setDeleting(true)}
          >
            {copy.deleteNote}
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
      {!locked && !diary && !editable && (
        <p className="assistant-note">{copy.clearHint}</p>
      )}
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
          {openableNote(result.path) && (
            <div className="assistant-actions">
              <button
                type="button"
                className="button secondary compact"
                aria-label={copy.openNoteNamed(result.path)}
                disabled={busy || draft.saving}
                onClick={() => openResult(result)}
              >
                {copy.openNote}
              </button>
            </div>
          )}
        </article>
      ))}
      <MemoryArchiveList
        assistantId={assistantId}
        locked={locked}
        onRestored={() => {
          // The note shown is read again, unless the owner is editing it.
          if (!draft.dirty) setReload((n) => n + 1);
        }}
      />
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={save}
        saveLabel={copy.saveNotes}
      />
      {deleting && (
        <ConfirmDialog
          destructive
          title={copy.deleteNoteTitle(name)}
          body={copy.deleteNoteBody}
          confirmLabel={copy.deleteNote}
          onConfirm={removeNote}
          onCancel={() => setDeleting(false)}
        />
      )}
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
        onCancel={() => {
          setNextName(null);
          setMatch(null);
        }}
      />
    </section>
  );
}
