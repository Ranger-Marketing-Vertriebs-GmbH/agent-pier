import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { memoryCopy as copy } from "../../lib/i18n/messages/memory.js";
import MemoryEditor from "../memory/MemoryEditor.jsx";
import MemoryHistory from "../memory/MemoryHistory.jsx";
import useProjectMemory from "../memory/useProjectMemory.js";
import {
  memoryPaging,
  memoryPageCount,
  entryAuthor,
} from "../memory/memory-presentation.js";
import { relativeTime } from "./ProjectOverview.jsx";
import { projectsRoute, projectsRoutePath } from "./routes.js";
import useSettledReplace from "../../lib/useSettledReplace.js";

// Both totals ignore the current search text, matching the project's own
// unfiltered entry counter shown on the hub tab.
function useEntryCounts(memoryId, version) {
  const [counts, setCounts] = useState({ active: 0, archived: 0 });
  useEffect(() => {
    if (!memoryId) {
      setCounts({ active: 0, archived: 0 });
      return;
    }
    let alive = true;
    const base = `/memory/projects/${encodeURIComponent(memoryId)}/entries`;
    Promise.all([
      api(`${base}?archived=false&page=1`),
      api(`${base}?archived=true&page=1`),
    ])
      .then(([active, archived]) => {
        if (alive)
          setCounts({ active: active.total || 0, archived: archived.total || 0 });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [memoryId, version]);
  return counts;
}

export default function ProjectKnowledge({ project, route, onNavigate, reloadHub }) {
  const query = route.query || "",
    page = route.memoryPage || 1,
    archived = route.archived === true;
  const state = useProjectMemory({
    projectId: project.memoryId,
    query,
    page,
    archived,
  });
  const action = useAsyncAction();
  const registerAction = useAsyncAction();
  const [search, setSearch] = useState(query);
  const [editor, setEditor] = useState(null);
  const [history, setHistory] = useState(null);
  const [expanded, setExpanded] = useState("");
  const [countVersion, setCountVersion] = useState(0);
  const counts = useEntryCounts(project.memoryId, countVersion);
  useEffect(() => {
    setSearch(query);
  }, [query]);
  const navigate = (changes) =>
    onNavigate({ ...route, projectId: project.id, projectTab: "knowledge", ...changes });
  const bump = () => {
    state.refresh();
    setCountVersion((value) => value + 1);
    reloadHub();
  };
  const lastPage = state.completedData ? memoryPageCount(state.completedData) : 0;
  const pageTarget =
    lastPage && page > lastPage
      ? { ...route, projectId: project.id, projectTab: "knowledge", memoryPage: lastPage }
      : null;
  useSettledReplace({
    target: pageTarget,
    targetPath: pageTarget ? projectsRoutePath(pageTarget) : "",
    currentPath: projectsRoutePath(route),
    navigate: onNavigate,
  });
  const changeArchive = (entry) =>
    action.run(async () => {
      await api(
        `/memory/projects/${encodeURIComponent(project.memoryId)}/entries/${encodeURIComponent(entry.id)}/archive`,
        "POST",
        { expectedRevision: entry.revision, archived: !entry.archived },
      );
      bump();
    });
  const register = () =>
    registerAction.run(async () => {
      const selected = await api("/memory/projects", "POST", { cwd: project.path });
      reloadHub();
      onNavigate(projectsRoute({ projectId: selected.id, projectTab: "knowledge" }));
    });
  if (!project.memoryId)
    return (
      <div className="project-knowledge">
        <p className="project-empty">{copy.notRegistered}</p>
        <ErrorMessage error={registerAction.error} />
        <button
          type="button"
          className="button primary"
          disabled={registerAction.busy}
          onClick={register}
        >
          {copy.addProject}
        </button>
      </div>
    );
  return (
    <div className="project-knowledge">
      <div className="project-knowledge-toolbar">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            navigate({ query: search, memoryPage: 1 });
          }}
        >
          <input
            aria-label={copy.search}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={copy.search}
          />
          <button className="button secondary compact">{copy.search}</button>
        </form>
        <div className="segment" role="group" aria-label={copy.entries}>
          <button
            type="button"
            className={archived ? "" : "selected"}
            aria-pressed={!archived}
            onClick={() => navigate({ archived: false, memoryPage: 1 })}
          >
            {copy.active} · {counts.active}
          </button>
          <button
            type="button"
            className={archived ? "selected" : ""}
            aria-pressed={archived}
            onClick={() => navigate({ archived: true, memoryPage: 1 })}
          >
            {copy.archived} · {counts.archived}
          </button>
        </div>
        <button
          type="button"
          className="button secondary compact"
          onClick={state.refresh}
          disabled={state.loading}
        >
          {commonCopy.refresh}
        </button>
        <button
          type="button"
          className="button primary"
          onClick={() => setEditor({ entry: null })}
        >
          <Icon name="plus" size={16} />
          {copy.newEntry}
        </button>
      </div>
      <p className="project-knowledge-hint">{copy.tabHint}</p>
      <ErrorMessage error={state.error || action.error} />
      {state.loading && (
        <p role="status" className="loading">
          {commonCopy.pending}
        </p>
      )}
      <section className="project-knowledge-entries" aria-label={copy.entries}>
        {!state.loading && state.data?.items.length === 0 && (
          <p className="project-empty">{copy.empty}</p>
        )}
        {state.data?.items.map((entry) => {
          const open = expanded === entry.id;
          const bodyId = `project-knowledge-body-${entry.id}`;
          const toggle = () => setExpanded(open ? "" : entry.id);
          const stopAnd = (run) => (event) => {
            event.stopPropagation();
            run();
          };
          return (
            <article className="project-knowledge-entry" key={entry.id} onClick={toggle}>
              <div className="project-knowledge-entry-head">
                <button
                  type="button"
                  className="project-knowledge-entry-toggle"
                  aria-expanded={open}
                  aria-controls={bodyId}
                  onClick={stopAnd(toggle)}
                >
                  <Icon
                    name="chevron"
                    size={14}
                    className="project-knowledge-entry-chevron"
                  />
                  {entry.title}
                </button>
                <span className="project-knowledge-entry-time">
                  {relativeTime(entry.updatedAt)}
                </span>
              </div>
              <div id={bodyId} className="project-knowledge-entry-body">
                <p className={open ? "expanded" : ""}>{entry.content}</p>
                <span className="project-knowledge-entry-meta">
                  {entryAuthor(entry)} · {copy.version(entry.revision)}
                </span>
              </div>
              {open && (
                <div className="project-knowledge-entry-actions">
                  {!entry.archived && (
                    <button
                      type="button"
                      className="button secondary compact"
                      aria-label={copy.edit(entry.title)}
                      onClick={stopAnd(() => setEditor({ entry }))}
                    >
                      {copy.editEntry}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button secondary compact"
                    aria-label={copy.history(entry.title)}
                    onClick={stopAnd(() => setHistory(entry))}
                  >
                    {copy.historyTitle}
                  </button>
                  <button
                    type="button"
                    className="button secondary compact"
                    aria-label={
                      entry.archived
                        ? copy.restore(entry.title)
                        : copy.archive(entry.title)
                    }
                    disabled={action.busy}
                    onClick={stopAnd(() => changeArchive(entry))}
                  >
                    {entry.archived ? copy.active : copy.archived}
                  </button>
                </div>
              )}
            </article>
          );
        })}
        {state.data && (
          <Pagination
            label={copy.entries}
            paging={memoryPaging(state.data, page, (next) =>
              navigate({ memoryPage: next }),
            )}
          />
        )}
      </section>
      {editor && (
        <MemoryEditor
          projectId={project.memoryId}
          entry={editor.entry}
          close={() => setEditor(null)}
          saved={bump}
        />
      )}
      {history && (
        <MemoryHistory
          projectId={project.memoryId}
          entry={history}
          close={() => setHistory(null)}
        />
      )}
    </div>
  );
}
