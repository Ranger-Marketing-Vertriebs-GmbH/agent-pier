import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { InfoHintButton, InfoHintText, useInfoHint } from "../../components/InfoHint.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import { locale } from "../../lib/i18n/index.js";
import { artifactCopy as copy } from "../../lib/i18n/messages/artifacts.js";
import { routePath } from "../../app/routes.js";
import useNarrowViewport from "../accounts/useNarrowViewport.js";
import ArtifactDetail from "./ArtifactDetail.jsx";
import ArtifactEmpty from "./ArtifactEmpty.jsx";
import ArtifactRows from "./ArtifactRows.jsx";
import { formatBytes, storageWarning } from "./artifact-presentation.js";
import { artifactsRoute } from "./routes.js";
import useArtifacts from "./useArtifacts.js";
import useArtifactSummary from "./useArtifactSummary.js";
import "./artifacts.css";

const pageSize = 20;

function useProjects() {
  const [projects, setProjects] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    api("/memory/projects", "GET", undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setProjects(result.projects || []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setProjects([]);
      });
    return () => controller.abort();
  }, []);
  return projects;
}

// The search box updates the list after a short pause in typing.
function useDebounced(value, delay = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

function Toolbar({ term, setTerm, projectId, projects, onProject }) {
  return (
    <div className="artifacts-toolbar">
      <label className="artifacts-search">
        <Icon name="search" size={16} />
        <input
          type="search"
          value={term}
          maxLength={200}
          placeholder={copy.search}
          aria-label={copy.search}
          onChange={(event) => setTerm(event.target.value)}
        />
      </label>
      <label className="artifacts-filter">
        <select
          value={projectId || ""}
          aria-label={copy.project}
          onChange={(event) => onProject(event.target.value)}
        >
          <option value="">{copy.allProjects}</option>
          {(projects || []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <Icon name="down" size={14} />
      </label>
    </div>
  );
}

/**
 * Artifacts: All and Pinned tabs, search and project filter, rows grouped by date.
 * A row opens its detail in the right pane (desktop) or as a subpage (phones); the
 * selection is `?artifact=<id>`, so the viewer's "Back to AgentPier" returns to it.
 */
export default function ArtifactsPage({
  route,
  onNavigate,
  sessions,
  tools,
  openNavigation,
  navigationOpen = false,
}) {
  const projects = useProjects();
  const narrow = useNarrowViewport();
  const info = useInfoHint();
  const tab = route.artifactTab === "pinned" ? "pinned" : "all";
  const [term, setTerm] = useState("");
  const q = useDebounced(term.trim());
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [gone, setGone] = useState(false);
  const filters = JSON.stringify([route.projectId || "", tab, q]);
  useEffect(() => setPage(1), [filters]);
  const list = useArtifacts({
    projectId: route.projectId || undefined,
    page,
    q,
    pinned: tab === "pinned",
  });
  const data = list.data;
  const counts = (data || list.stale)?.counts;
  const items = data?.items || [];
  const pageCount = Math.max(1, Math.ceil((data?.total || 0) / pageSize));
  useEffect(() => {
    if (data && page > pageCount) setPage(pageCount);
  }, [data, page, pageCount]);
  // Desktop shows the newest artifact until one is chosen; phones start on the list.
  const selectedId = route.artifact || (!narrow && items[0]?.id) || "";
  const listed = items.find((item) => item.id === selectedId);
  const summary = useArtifactSummary(selectedId, listed, revision);
  const go = (fields, replace) => onNavigate({ ...route, ...fields }, replace);
  useEffect(() => {
    if (!route.artifact || !summary.gone) return;
    setGone(true);
    onNavigate({ ...route, artifact: "" }, true);
  }, [route, summary.gone, onNavigate]);
  const item = summary.item;
  const subpage = narrow && Boolean(route.artifact);
  const lists = { sessions, projects, tools };
  const usage = list.usage;
  const warn = storageWarning(usage);
  const usageText =
    usage &&
    copy.storage(
      formatBytes(usage.usedBytes, locale),
      formatBytes(usage.limitBytes, locale),
    );
  const subtitle = [data && copy.results(data.total), usageText]
    .filter(Boolean)
    .join(" · ");
  const select = (entry) => {
    setGone(false);
    go({ artifact: entry.id });
  };
  const clearFilters = () => {
    setTerm("");
    onNavigate(artifactsRoute({ artifactTab: tab }));
  };
  return (
    <SettingsShell
      className="artifacts-page"
      title={subpage ? item?.title || copy.title : copy.title}
      subtitle={subpage ? copy.title : subtitle || undefined}
      description={subpage ? undefined : copy.description}
      leading={subpage ? "back" : "menu"}
      onLeading={subpage ? () => go({ artifact: "" }) : openNavigation}
      navigationOpen={navigationOpen}
      actions={
        subpage ? null : (
          <>
            {usageText && (
              <span
                className={["artifacts-usage", warn ? "is-warn" : ""].join(" ").trim()}
              >
                {usageText}
              </span>
            )}
            <InfoHintButton hint={info} label={copy.infoLabel} />
          </>
        )
      }
      tabs={
        subpage ? null : (
          <UnderlineTabs
            label={copy.tabsLabel}
            idPrefix="artifacts"
            tabs={["all", "pinned"].map((id) => ({
              id,
              label: copy.tabs[id],
              count: counts?.[id],
            }))}
            selected={tab}
            onSelect={(id) => go({ artifactTab: id, artifact: "" })}
          />
        )
      }
    >
      {!subpage && (
        <InfoHintText hint={info}>
          {[
            warn ? copy.storageFull : "",
            copy.retention,
            usage?.pendingCleanupBytes > 0
              ? copy.cleanup(formatBytes(usage.pendingCleanupBytes, locale))
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
        </InfoHintText>
      )}
      {gone && !subpage && (
        <p className="artifacts-notice" role="status">
          {copy.gone}
        </p>
      )}
      <div
        role="tabpanel"
        id={`artifacts-tabpanel-${tab}`}
        aria-labelledby={`artifacts-tab-${tab}`}
        className={[
          "artifacts-layout",
          item ? "has-detail" : "",
          subpage ? "is-subpage" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {!subpage && (
          <div className="artifacts-list">
            <Toolbar
              term={term}
              setTerm={setTerm}
              projectId={route.projectId}
              projects={projects}
              onProject={(projectId) =>
                onNavigate(artifactsRoute({ projectId, artifactTab: tab }))
              }
            />
            <ErrorMessage error={list.error} />
            {!data ? (
              <p className="loading" role="status">
                {copy.listLoading}
              </p>
            ) : !items.length ? (
              <ArtifactEmpty
                term={q}
                filtered={Boolean(q || route.projectId)}
                pinned={tab === "pinned"}
                onClear={clearFilters}
              />
            ) : (
              <>
                <ArtifactRows
                  items={items}
                  lists={lists}
                  selectedId={selectedId}
                  onSelect={select}
                  hrefFor={(entry) => routePath({ ...route, artifact: entry.id })}
                />
                <Pagination
                  label={copy.title}
                  paging={{
                    page: page - 1,
                    pageSize,
                    pageCount,
                    total: data.total,
                    start: (page - 1) * pageSize + 1,
                    end: Math.min(page * pageSize, data.total),
                    setPage: (value) => setPage(value + 1),
                  }}
                />
              </>
            )}
          </div>
        )}
        {item ? (
          <div className="artifacts-pane">
            <ArtifactDetail
              key={item.id}
              item={item}
              lists={lists}
              heading={!subpage}
              returnTo={routePath({ ...route, artifact: item.id })}
              navigate={onNavigate}
              onChanged={() => {
                list.refresh();
                setRevision((value) => value + 1);
              }}
              onRemoved={() => {
                list.refresh();
                go({ artifact: "" });
              }}
            />
          </div>
        ) : subpage ? (
          summary.error && !summary.gone ? (
            <ErrorMessage error={summary.error} />
          ) : (
            <p className="loading" role="status">
              {copy.loading}
            </p>
          )
        ) : null}
      </div>
    </SettingsShell>
  );
}
