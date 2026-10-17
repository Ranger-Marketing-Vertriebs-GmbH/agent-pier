import { useEffect, useId, useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import { InfoHintButton, InfoHintText, useInfoHint } from "../../components/InfoHint.jsx";
import ListCard from "../../components/ListCard.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import Segmented from "../../components/Segmented.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { memoryCopy as copy } from "../../lib/i18n/messages/memory.js";
import MemoryEditor from "../memory/MemoryEditor.jsx";
import MemoryHistory from "../memory/MemoryHistory.jsx";
import MemoryForget from "../memory/MemoryForget.jsx";
import useProjectMemory from "../memory/useProjectMemory.js";
import { memoryPaging, memoryPageCount } from "../memory/memory-presentation.js";
import CountUnavailable from "./CountUnavailable.jsx";
import ProjectKnowledgeEntry from "./ProjectKnowledgeEntry.jsx";
import { projectsRoute, projectsRoutePath } from "./routes.js";
import useSettledReplace from "../../lib/useSettledReplace.js";

const unknownCounts = { memoryId: "", active: null, archived: null, failed: false };

// Both totals ignore the current search text, matching the project's own
// unfiltered entry counter shown on the hub tab. A count is null until it is known;
// a refresh keeps the last counts of the same project until the new ones arrive.
function useEntryCounts(memoryId, version) {
  const [counts, setCounts] = useState(unknownCounts);
  useEffect(() => {
    if (!memoryId) return;
    let alive = true;
    const base = `/memory/projects/${encodeURIComponent(memoryId)}/entries`;
    Promise.all([
      api(`${base}?archived=false&page=1`),
      api(`${base}?archived=true&page=1`),
    ])
      .then(([active, archived]) => {
        if (alive)
          setCounts({
            memoryId,
            active: active.total || 0,
            archived: archived.total || 0,
            failed: false,
          });
      })
      .catch(() => {
        if (alive) setCounts({ ...unknownCounts, memoryId, failed: true });
      });
    return () => {
      alive = false;
    };
  }, [memoryId, version]);
  return counts.memoryId === memoryId ? counts : unknownCounts;
}

const withCount = (label, count) => (count === null ? label : `${label} · ${count}`);

export default function ProjectKnowledge({
  project,
  route,
  onNavigate,
  reloadHub,
  mobile = false,
}) {
  const query = route.query || "",
    page = route.memoryPage || 1,
    archived = route.archived === true,
    sort = route.memorySort === "newest" ? "newest" : "relevance";
  const state = useProjectMemory({
    projectId: project.memoryId,
    query,
    page,
    archived,
    sort,
  });
  const action = useAsyncAction();
  const registerAction = useAsyncAction();
  const [search, setSearch] = useState(query);
  const [editor, setEditor] = useState(null);
  const [history, setHistory] = useState(null);
  const [forgetting, setForgetting] = useState(null);
  const [expanded, setExpanded] = useState("");
  const [countVersion, setCountVersion] = useState(0);
  const counts = useEntryCounts(project.memoryId, countVersion);
  const hint = useInfoHint();
  const entriesHeading = useId();
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
      <form
        className="project-knowledge-search"
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
      <div className="project-knowledge-filter">
        <Segmented
          label={copy.entries}
          value={archived ? "archived" : "active"}
          options={[
            { value: "active", label: withCount(copy.active, counts.active) },
            { value: "archived", label: withCount(copy.archived, counts.archived) },
          ]}
          onChange={(value) =>
            navigate({ archived: value === "archived", memoryPage: 1 })
          }
        />
        <InfoHintButton hint={hint} />
        <button
          type="button"
          className="button secondary compact"
          onClick={state.refresh}
          disabled={state.loading}
        >
          {commonCopy.refresh}
        </button>
      </div>
      {query && (
        <div className="project-knowledge-filter">
          <Segmented
            label={copy.sortLabel}
            value={sort}
            options={[
              { value: "relevance", label: copy.sortRelevance },
              { value: "newest", label: copy.sortNewest },
            ]}
            onChange={(value) => navigate({ memorySort: value, memoryPage: 1 })}
          />
        </div>
      )}
      <InfoHintText hint={hint}>{copy.tabHint}</InfoHintText>
      {counts.failed && (
        <CountUnavailable
          message={copy.countsUnavailable}
          onRetry={() => setCountVersion((value) => value + 1)}
        />
      )}
      <ErrorMessage error={state.error || action.error} />
      {state.loading && (
        <p role="status" className="loading">
          {commonCopy.pending}
        </p>
      )}
      <GroupLabel
        as={mobile ? "h2" : "h3"}
        id={entriesHeading}
        action={{
          label: (
            <>
              <span aria-hidden="true">+ </span>
              {copy.newEntry}
            </>
          ),
          onClick: () => setEditor({ entry: null }),
        }}
      >
        {copy.entries}
      </GroupLabel>
      {!state.loading && state.data?.items.length === 0 && (
        <p className="project-empty">{copy.empty}</p>
      )}
      {state.data?.items.length > 0 && (
        <ListCard labelledBy={entriesHeading} className="project-knowledge-entries">
          {state.data.items.map((entry) => (
            <ProjectKnowledgeEntry
              key={entry.id}
              entry={entry}
              open={expanded === entry.id}
              onToggle={() =>
                setExpanded((current) => (current === entry.id ? "" : entry.id))
              }
              busy={action.busy}
              onEdit={() => setEditor({ entry })}
              onHistory={() => setHistory(entry)}
              onArchive={() => changeArchive(entry)}
              onForget={() => setForgetting(entry)}
            />
          ))}
        </ListCard>
      )}
      {state.data && (
        <Pagination
          label={copy.entries}
          paging={memoryPaging(state.data, page, (next) =>
            navigate({ memoryPage: next }),
          )}
        />
      )}
      {editor && (
        <MemoryEditor
          projectId={project.memoryId}
          entry={editor.entry}
          close={() => setEditor(null)}
          saved={bump}
        />
      )}
      {forgetting && (
        <MemoryForget
          projectId={project.memoryId}
          entry={forgetting}
          close={() => setForgetting(null)}
          forgotten={bump}
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
