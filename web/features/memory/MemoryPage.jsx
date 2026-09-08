import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { memoryCopy as copy } from "../../lib/i18n/messages/memory.js";
import MemoryEditor from "./MemoryEditor.jsx";
import MemoryHistory from "./MemoryHistory.jsx";
import useProjectMemory from "./useProjectMemory.js";
import { memoryPaging, memoryPageCount, entryAuthor } from "./memory-presentation.js";
import "./memory.css";

export default function MemoryPage({ route, onNavigate, home }) {
  const projectId = route.projectId || "",
    query = route.query || "",
    page = route.memoryPage || 1,
    archived = route.archived === true;
  const state = useProjectMemory({ projectId, query, page, archived });
  const action = useAsyncAction();
  const [directory, setDirectory] = useState(home || ""),
    [search, setSearch] = useState(query),
    [editor, setEditor] = useState(null),
    [history, setHistory] = useState(null);
  const navigate = (changes) => onNavigate({ ...route, view: "memory", ...changes });
  useEffect(() => {
    setSearch(query);
  }, [query]);
  useEffect(() => {
    setEditor(null);
    setHistory(null);
  }, [projectId]);
  useEffect(() => {
    if (!state.completedData) return;
    const lastPage = memoryPageCount(state.completedData);
    if (page > lastPage) onNavigate({ ...route, memoryPage: lastPage }, true);
  }, [state.completedData, page, route, onNavigate]);
  const project = state.projects.find((item) => item.id === projectId);
  const changeArchive = (entry) =>
    action.run(async () => {
      await api(
        `/memory/projects/${encodeURIComponent(projectId)}/entries/${encodeURIComponent(entry.id)}/archive`,
        "POST",
        { expectedRevision: entry.revision, archived: !entry.archived },
      );
      state.refresh();
    });
  return (
    <div className="page memory-page">
      <div className="page-heading">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
      </div>
      <p className="memory-note">{copy.scope}</p>
      <section className="memory-projects">
        <AnchoredSelect
          label={copy.project}
          value={projectId}
          options={[
            { value: "", label: copy.project },
            ...state.projects.map((item) => ({ value: item.id, label: item.name })),
          ]}
          onChange={(value) =>
            navigate({ projectId: value, memoryPage: 1, query: "", archived: false })
          }
        />
        <details>
          <summary>{copy.addProject}</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              action.run(async () => {
                const selected = await api("/memory/projects", "POST", {
                  cwd: directory,
                });
                state.refresh();
                navigate({
                  projectId: selected.id,
                  memoryPage: 1,
                  query: "",
                  archived: false,
                });
              });
            }}
          >
            <label>
              {copy.directory}
              <input
                required
                value={directory}
                onChange={(event) => setDirectory(event.target.value)}
                disabled={action.busy}
              />
            </label>
            <button className="button secondary" disabled={action.busy}>
              {copy.addProject}
            </button>
          </form>
        </details>
      </section>
      <ErrorMessage error={state.error || action.error} />
      {!projectId ? (
        <p className="memory-note">{copy.noProjects}</p>
      ) : (
        <>
          {project && <p className="memory-directory">{project.cwd}</p>}
          <div className="memory-toolbar">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                navigate({ query: search, memoryPage: 1 });
              }}
            >
              <label>
                <span className="sr-only">{copy.search}</span>
                <input
                  aria-label={copy.search}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={copy.search}
                />
              </label>
              <button className="button secondary">{copy.search}</button>
            </form>
            <button
              className="button secondary"
              onClick={state.refresh}
              disabled={state.loading}
            >
              {commonCopy.refresh}
            </button>
            <button
              className="button primary"
              disabled={!project}
              onClick={() => setEditor({ entry: null })}
            >
              {copy.newEntry}
            </button>
          </div>
          <div className="memory-tabs" role="group" aria-label={copy.entries}>
            <button
              className={archived ? "" : "selected"}
              aria-pressed={!archived}
              onClick={() => navigate({ archived: false, memoryPage: 1 })}
            >
              {copy.active}
            </button>
            <button
              className={archived ? "selected" : ""}
              aria-pressed={archived}
              onClick={() => navigate({ archived: true, memoryPage: 1 })}
            >
              {copy.archived}
            </button>
          </div>
          {state.loading && (
            <p role="status" className="memory-note">
              {commonCopy.pending}
            </p>
          )}
          <section className="memory-entries" aria-label={copy.entries}>
            {!state.loading && state.data?.items.length === 0 && <p>{copy.empty}</p>}
            {state.data?.items.map((entry) => (
              <article className="memory-entry" key={entry.id}>
                <h2>{entry.title}</h2>
                <small>
                  {entryAuthor(entry)} · {copy.version(entry.revision)}
                </small>
                <pre>{entry.content}</pre>
                <div className="memory-actions">
                  {!entry.archived && (
                    <button
                      className="button secondary compact"
                      aria-label={copy.edit(entry.title)}
                      onClick={() => setEditor({ entry })}
                    >
                      {copy.editEntry}
                    </button>
                  )}
                  <button
                    className="button secondary compact"
                    aria-label={copy.history(entry.title)}
                    onClick={() => setHistory(entry)}
                  >
                    {copy.historyTitle}
                  </button>
                  <button
                    className="button secondary compact"
                    aria-label={
                      entry.archived
                        ? copy.restore(entry.title)
                        : copy.archive(entry.title)
                    }
                    disabled={action.busy}
                    onClick={() => changeArchive(entry)}
                  >
                    {entry.archived ? copy.active : copy.archived}
                  </button>
                </div>
              </article>
            ))}
            {state.data && (
              <Pagination
                label={copy.entries}
                paging={memoryPaging(state.data, page, (next) =>
                  navigate({ memoryPage: next }),
                )}
              />
            )}
          </section>
        </>
      )}
      {editor && (
        <MemoryEditor
          projectId={projectId}
          entry={editor.entry}
          close={() => setEditor(null)}
          saved={state.refresh}
        />
      )}
      {history && (
        <MemoryHistory
          projectId={projectId}
          entry={history}
          close={() => setHistory(null)}
        />
      )}
    </div>
  );
}
