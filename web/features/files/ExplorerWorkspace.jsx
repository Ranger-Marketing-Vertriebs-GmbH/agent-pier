import FileEditorWorkspace from "./FileEditorWorkspace.jsx";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "../../lib/api.js";
import { browserUuid } from "../../lib/browser-uuid.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Modal from "../../components/Modal.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";
import { fileApi } from "./file-api.js";
import useFileListing from "./useFileListing.js";
import useFilePreferences from "./useFilePreferences.js";
import ExplorerToolbar from "./ExplorerToolbar.jsx";
import ExplorerDirectoryTree from "./ExplorerDirectoryTree.jsx";
import ExplorerListing from "./ExplorerListing.jsx";
import useFileJobs from "./useFileJobs.js";
import FileProperties from "./FileProperties.jsx";
import ExplorerTransfers from "./ExplorerTransfers.jsx";
import useFileUploads from "./useFileUploads.js";
import TrashView from "./TrashView.jsx";
import useFileSelection from "./useFileSelection.js";
import useFileClipboard, { useClipboardResults } from "./useFileClipboard.js";
import { useExplorerFileShortcuts, useOwnedListAction } from "./useFileShortcuts.js";
import { explorerLayoutCopy as layout } from "../../lib/i18n/messages/explorer-layout.js";
import useExplorerDrag from "./useExplorerDrag.js";
import useExplorerPreviewReturn from "./useExplorerPreviewReturn.js";
import "./files.css";
export default function ExplorerWorkspace({ scopeRef, route, navigate }) {
  const kind = scopeRef.kind;
  const sessionId = scopeRef.sessionId;
  const contextKey = `${kind}:${sessionId || ""}:${scopeRef.contextKey || ""}`;
  const client = useMemo(
    () => fileApi({ kind, sessionId, contextKey }),
    [contextKey, kind, sessionId],
  );
  const [contextResult, setContext] = useState(null);
  const context = contextResult?.client === client ? contextResult.value : null;
  const queue = useFileJobs(client);
  const startJob = queue.start;
  const [activityRequest, setActivityRequest] = useState(null);
  const isExternalDrop = (event) =>
    !context?.readOnly &&
    event.dataTransfer.types.includes("Files") &&
    !event.dataTransfer.types.includes("application/x-agentpier-files");
  const startOperation = useCallback(
    (scopeId, body) => {
      setActivityRequest({ scopeId });
      return startJob(scopeId, body);
    },
    [startJob],
  );
  const jobs = { ...queue, start: startOperation };
  const [searchResult, setSearchResult] = useState(null);
  const [sizeResult, setSizeResult] = useState(null);
  const [searchPending, setSearchPending] = useState(null);
  const [contextError, setContextError] = useState(null);
  const [projects, setProjects] = useState([]);
  const [treeOpen, setTreeOpen] = useState(false);
  const [toolbarTarget, setToolbarTarget] = useState(null);
  const [transferToolbarTarget, setTransferToolbarTarget] = useState(null);
  const [previewTarget, setPreviewTarget] = useState(null);
  const [uploadRequest, setUploadRequest] = useState(0);
  const { explorerRef, previewOrigin } = useExplorerPreviewReturn(route.file);
  const previousScope = useRef(null);
  const path = route.filePath || "";
  const page = route.filePage || 1;
  const sort = route.fileSort || "name";
  const direction = route.fileDirection || "asc";
  const hidden = Boolean(route.fileHidden);
  const invalidPage =
    route.filePageInvalid !== null && route.filePageInvalid !== undefined;
  const changeRoute = (changes, replace = false) =>
    navigate(
      {
        ...route,
        ...changes,
        filePageInvalid: Object.hasOwn(changes, "filePageInvalid")
          ? changes.filePageInvalid
          : null,
      },
      replace,
    );
  const goPath = (nextPath, replace = false) =>
    changeRoute(
      {
        filePath: nextPath,
        file: "",
        filePage: 1,
        filePageInvalid: null,
      },
      replace,
    );
  useEffect(() => {
    const controller = new AbortController();
    setContext(null);
    setContextError(null);
    client
      .get("/context", {}, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        const changed = previousScope.current && previousScope.current !== result.scopeId;
        previousScope.current = result.scopeId;
        setContext({ client, value: result });
        if (changed) goPath(result.kind === "global" ? result.home : "", true);
        else if (result.kind === "global" && !route.filePath)
          changeRoute(
            {
              filePath: result.home,
              file: "",
              filePageInvalid: route.filePageInvalid,
            },
            true,
          );
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setContextError(issue);
      });
    return () => controller.abort();
    // contextKey explicitly observes a same-session CWD change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, contextKey]);
  useEffect(() => {
    if (context?.kind !== "global") {
      setProjects([]);
      return;
    }
    const controller = new AbortController();
    api("/repositories", "GET", undefined, controller.signal)
      .then((result) =>
        setProjects(
          result.projects.map((project) => ({
            id: project.id,
            kind: "project",
            name: project.name,
            path: project.path,
          })),
        ),
      )
      .catch(() => setProjects([]));
    return () => controller.abort();
  }, [context?.kind]);
  const preferences = useFilePreferences({ client, scopeId: context?.scopeId });
  useEffect(() => {
    if (context && preferences.preferences.showHidden && !route.fileHiddenExplicit)
      changeRoute(
        {
          fileHidden: true,
          filePageInvalid: route.filePageInvalid,
        },
        true,
      );
    // Apply the saved default only when preferences finish loading for this scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context?.scopeId, preferences.loading]);

  const listing = useFileListing({
    client,
    path: invalidPage || !context ? null : path,
    page,
    sort,
    direction,
    hidden,
  });
  useEffect(() => {
    if (listing.listing && listing.listing.path !== path)
      goPath(listing.listing.path, true);
    // Canonicalize server-resolved inputs such as ~ without creating a history entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing.listing?.path, path]);
  const [entryResult, setEntry] = useState(null);
  const [propertiesError, setPropertiesError] = useState(null);
  const [propertiesLoading, setPropertiesLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const scopeId = context?.scopeId;
  const uploads = useFileUploads({
    client,
    folder: path,
    scopeId,
    jobs,
    limits: context?.limits,
    readOnly: context?.readOnly,
  });
  const actionOwner = useMemo(
    () => ({ client, scopeId, path, panel: route.filePanel }),
    [client, path, route.filePanel, scopeId],
  );
  const fileSelection = useFileSelection(listing.listing?.entries || [], actionOwner);
  const clipboard = useFileClipboard(context);
  useClipboardResults(clipboard, jobs.entries);
  const [actionRequest, setActionRequest] = useState(null);
  useEffect(() => setActionRequest(null), [actionOwner]);
  const requestListAction = useOwnedListAction(actionOwner, setActionRequest);
  const dragEvents = useExplorerDrag(actionOwner, setActionRequest);
  const actionScope = context && { ...context, path };
  const terminalJobs = jobs.jobs
    .filter(
      (job) =>
        !["search", "size"].includes(job.kind) &&
        [
          "completed",
          "partially_completed",
          "failed",
          "cancelled",
          "interrupted",
        ].includes(job.status),
    )
    .map((job) => `${job.id}:${job.status}:${job.completedEntries}`)
    .sort()
    .join("|");
  const refreshListing = listing.refresh;
  useEffect(() => {
    refreshListing();
  }, [terminalJobs, refreshListing]);
  const selectionOwner = useRef(null);
  const linkOperation = useRef({ generation: 0, controller: null });
  if (
    !selectionOwner.current ||
    selectionOwner.current.client !== client ||
    selectionOwner.current.scopeId !== scopeId ||
    selectionOwner.current.file !== route.file
  )
    selectionOwner.current = { client, scopeId, file: route.file };
  const entry = entryResult?.owner === selectionOwner.current ? entryResult.value : null;
  const preview =
    previewResult?.owner === selectionOwner.current ? previewResult.value : null;

  useEffect(() => {
    const owner = selectionOwner.current;
    const controller = new AbortController();
    const cancelLink = () => {
      linkOperation.current.controller?.abort();
      linkOperation.current = {
        generation: linkOperation.current.generation + 1,
        controller: null,
      };
    };
    const stop = () => {
      controller.abort();
      cancelLink();
    };
    cancelLink();
    setEntry(null);
    setPreviewResult(null);
    setPropertiesError(null);
    setPreviewError(null);
    setPropertiesLoading(false);
    if (!scopeId || !route.file) return stop;
    setPropertiesLoading(true);
    client
      .get("/metadata", { path: route.file }, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) return;
        setEntry({ owner, value: result });
        if (result.type === "file") {
          try {
            const value = await client.get(
              "/preview",
              { path: route.file },
              controller.signal,
            );
            if (!controller.signal.aborted) setPreviewResult({ owner, value });
          } catch (issue) {
            if (!controller.signal.aborted) setPreviewError(issue);
          }
        }
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setPropertiesError(issue);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPropertiesLoading(false);
      });
    return stop;
  }, [client, scopeId, route.file]);

  const startSearch = async (options) => {
    const owner = { client };
    setSearchPending(owner);
    try {
      const job = await jobs.start(scopeId, {
        kind: "search",
        sources: [path],
        target: null,
        name: null,
        options,
      });
      setSearchResult({ client, id: job.id });
    } catch {
      /* Reactive job error is shown by FileJobs. */
    } finally {
      setSearchPending((current) => (current === owner ? null : current));
    }
  };
  const startSize = async () => {
    const owner = selectionOwner.current;
    setSizeResult({ owner, pending: true });
    try {
      const job = await jobs.start(scopeId, {
        kind: "size",
        sources: [entry.path],
        target: null,
        name: null,
        options: {},
      });
      if (selectionOwner.current === owner) setSizeResult({ owner, id: job.id });
    } catch {
      if (selectionOwner.current === owner) setSizeResult(null);
    }
  };
  const sizeSelection = sizeResult?.owner === selectionOwner.current ? sizeResult : null;
  const currentFavorite = preferences.preferences.favorites.find(
    (favorite) => favorite.path === path,
  );
  const updateFavorite = async () => {
    const added = currentFavorite
      ? null
      : {
          id: browserUuid(),
          name:
            path.split("/").filter(Boolean).at(-1) ||
            (context.kind === "project" ? copy.root : path),
          path,
        };
    await preferences
      .update((latest) => ({
        favorites: currentFavorite
          ? latest.favorites.filter((favorite) => favorite.id !== currentFavorite.id)
          : [...latest.favorites, added],
      }))
      .catch(() => {});
  };
  const showProperties = (selected, origin = document.activeElement) => {
    previewOrigin.current = {
      element: origin,
      scrollTop: explorerRef.current?.scrollTop || 0,
    };
    changeRoute({ file: selected.path, filePage: page });
  };
  const openEntry = (selected, origin) => {
    if (selected.type === "directory") goPath(selected.path);
    else showProperties(selected, origin);
  };
  const handleShortcuts = useExplorerFileShortcuts(
    fileSelection,
    clipboard,
    requestListAction,
    openEntry,
  );
  const openLink = async () => {
    const owner = selectionOwner.current;
    linkOperation.current.controller?.abort();
    const controller = new AbortController();
    const generation = linkOperation.current.generation + 1;
    linkOperation.current = { generation, controller };
    const owns = () =>
      !controller.signal.aborted &&
      selectionOwner.current === owner &&
      linkOperation.current.generation === generation;
    setPreviewError(null);
    try {
      await client.get(
        "/entries",
        {
          path: entry.path,
          page: 1,
          sort: "name",
          direction: "asc",
          hidden: hidden ? 1 : 0,
        },
        controller.signal,
      );
      if (!owns()) return;
      goPath(entry.path);
    } catch (issue) {
      if (!owns()) return;
      if (issue.code !== "FILE_NOT_DIRECTORY") {
        setPreviewError(issue);
        return;
      }
      try {
        const value = await client.get(
          "/preview",
          { path: entry.path },
          controller.signal,
        );
        if (owns()) setPreviewResult({ owner, value });
      } catch (previewIssue) {
        if (owns()) setPreviewError(previewIssue);
      }
    } finally {
      if (linkOperation.current.generation === generation)
        linkOperation.current = { generation, controller: null };
    }
  };
  const refresh = (restoreFocus) => {
    if (invalidPage) changeRoute({ filePage: 1, filePageInvalid: null, file: "" }, true);
    listing.refresh(restoreFocus);
  };
  const directoryTree = context && (
    <ExplorerDirectoryTree
      client={client}
      context={context}
      hidden={hidden}
      preferences={preferences}
      projects={projects}
      open={treeOpen ? setTreeOpen : null}
      navigate={goPath}
    />
  );

  return (
    <section
      ref={explorerRef}
      className={`file-explorer ${kind === "project" ? "project-explorer" : "global-explorer"} ${route.file ? "has-preview" : ""}`}
      onDragOver={(event) => {
        if (isExternalDrop(event)) event.preventDefault();
      }}
      onDrop={(event) => {
        if (isExternalDrop(event)) {
          event.preventDefault();
          uploads.add(event.dataTransfer);
          setUploadRequest((value) => value + 1);
        }
      }}
      aria-label={copy.tab}
      onKeyDown={route.filePanel === "trash" ? undefined : handleShortcuts}
    >
      {kind === "global" && (
        <div className="explorer-page-heading">
          <h1>{copy.tab}</h1>
          <span>{layout.host}</span>
        </div>
      )}
      <ErrorMessage error={contextError?.message} />
      {context && (
        <>
          <ExplorerToolbar
            rootLabel={context.root.split("/").filter(Boolean).at(-1) || copy.root}
            onSearch={startSearch}
            searching={searchPending?.client === client}
            path={path}
            project={context.kind === "project"}
            parent={listing.listing?.parent ?? null}
            sort={sort}
            direction={direction}
            hidden={hidden}
            favorite={currentFavorite}
            busy={preferences.loading}
            onPath={goPath}
            onSort={(fileSort) => changeRoute({ fileSort, filePage: 1, file: "" })}
            onDirection={(fileDirection) =>
              changeRoute({ fileDirection, filePage: 1, file: "" })
            }
            onHidden={(fileHidden) => {
              changeRoute({
                fileHidden,
                fileHiddenExplicit: true,
                filePage: 1,
                file: "",
              });
              preferences.update({ showHidden: fileHidden }).catch(() => {});
            }}
            onFavorite={updateFavorite}
            onRefresh={refresh}
            onTree={() => setTreeOpen(true)}
          >
            <div className="explorer-primary-actions">
              <span className="explorer-action-slot" ref={setToolbarTarget} />
              <span className="explorer-action-slot" ref={setTransferToolbarTarget} />
            </div>
          </ExplorerToolbar>
          <ErrorMessage error={preferences.error?.message} />
          <ExplorerTransfers
            key={scopeId}
            toolbarTarget={transferToolbarTarget}
            onLeavePreview={() => changeRoute({ file: "" })}
            uploads={uploads}
            jobs={jobs}
            scope={actionScope}
            client={client}
            uploadRequest={uploadRequest}
            activityRequest={
              activityRequest?.scopeId === scopeId ? activityRequest : null
            }
            searchId={searchResult?.client === client ? searchResult.id : null}
            onResult={(result) => {
              const parent = result.path.split("/").slice(0, -1).join("/");
              changeRoute({
                filePath: parent || (kind === "global" ? "/" : ""),
                file: result.path,
                filePage: 1,
                filePageInvalid: null,
              });
            }}
          />
          <nav className="explorer-panels" aria-label={copy.actions.panels}>
            <button
              aria-pressed={route.filePanel !== "trash"}
              onClick={() => changeRoute({ filePanel: "files" })}
            >
              {copy.fileList}
            </button>
            <button
              aria-pressed={route.filePanel === "trash"}
              onClick={() => changeRoute({ filePanel: "trash", file: "" })}
            >
              {copy.actions.trashTitle}
            </button>
          </nav>
          {route.filePanel === "trash" ? (
            <TrashView
              key={`${contextKey}:${scopeId}`}
              scope={actionScope}
              client={client}
              jobs={jobs}
              onChanged={refresh}
              onOpenOriginal={(original) =>
                changeRoute({
                  filePanel: "files",
                  filePath:
                    original.split("/").slice(0, -1).join("/") ||
                    (kind === "global" ? "/" : ""),
                  file: "",
                  filePage: 1,
                })
              }
            />
          ) : invalidPage ? (
            <div className="explorer-page-error">
              <ErrorMessage error={copy.errors.FILE_INVALID_PAGE} />
              <button className="button secondary" onClick={refresh}>
                {copy.refresh}
              </button>
            </div>
          ) : (
            <div className="file-explorer-columns">
              <aside className="explorer-tree-column">{directoryTree}</aside>
              <ExplorerListing
                key={`${contextKey}:${scopeId}:${path}`}
                listing={listing}
                toolbarTarget={toolbarTarget}
                scope={actionScope}
                title={
                  path === context.home && kind === "global"
                    ? layout.home
                    : path.split("/").filter(Boolean).at(-1) ||
                      (kind === "global" ? "/" : layout.projectFiles)
                }
                selection={fileSelection}
                clipboard={clipboard}
                jobs={jobs}
                request={actionRequest?.owner === actionOwner ? actionRequest : null}
                onRequestHandled={() => setActionRequest(null)}
                onRefresh={refresh}
                route={route}
                onOpen={openEntry}
                onProperties={showProperties}
                onPage={(filePage) => changeRoute({ filePage, file: "" })}
                onAction={requestListAction}
                {...dragEvents}
              />
              {route.file && (
                <FileProperties
                  actionTarget={setPreviewTarget}
                  selectedPath={route.file}
                  sizeJob={jobs.jobs.find((job) => job.id === sizeSelection?.id)}
                  sizePending={sizeSelection?.pending}
                  onSize={startSize}
                  entry={entry}
                  downloadHref={
                    entry?.type === "file" ? client.directDownload(entry.path) : null
                  }
                  preview={preview}
                  error={propertiesError}
                  previewError={previewError}
                  previewOwner={selectionOwner.current}
                  loading={propertiesLoading}
                  onClose={() => changeRoute({ file: "", filePage: page })}
                  onOpenLink={openLink}
                />
              )}
            </div>
          )}
          {treeOpen && (
            <Modal title={copy.directoryTree} close={() => setTreeOpen(false)}>
              {directoryTree}
            </Modal>
          )}
        </>
      )}
      <FileEditorWorkspace
        client={client}
        context={context}
        path={route.file}
        canOpen={preview?.type === "text"}
        openTarget={previewTarget}
      />
    </section>
  );
}
