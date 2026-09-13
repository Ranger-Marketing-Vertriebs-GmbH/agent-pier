import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Modal from "../../components/Modal.jsx";
import CreateDirectory from "../directories/CreateDirectory.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";
import { fileApi } from "./file-api.js";
import useFileListing from "./useFileListing.js";
import useFilePreferences from "./useFilePreferences.js";
import ExplorerToolbar from "./ExplorerToolbar.jsx";
import DirectoryTree from "./DirectoryTree.jsx";
import FileList from "./FileList.jsx";
import FileProperties from "./FileProperties.jsx";
import "./files.css";

export default function ExplorerWorkspace({ scopeRef, route, navigate }) {
  const kind = scopeRef.kind;
  const sessionId = scopeRef.sessionId;
  const contextKey = `${kind}:${sessionId || ""}:${scopeRef.contextKey || ""}`;
  const client = useMemo(
    () => fileApi({ kind, sessionId, contextKey }),
    [contextKey, kind, sessionId],
  );
  const [context, setContext] = useState(null);
  const [contextError, setContextError] = useState(null);
  const [projects, setProjects] = useState([]);
  const [treeOpen, setTreeOpen] = useState(false);
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
        setContext(result);
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
  const [entry, setEntry] = useState(null);
  const [propertiesError, setPropertiesError] = useState(null);
  const [propertiesLoading, setPropertiesLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const scopeId = context?.scopeId;

  useEffect(() => {
    const controller = new AbortController();
    setEntry(null);
    setPreview(null);
    setPropertiesError(null);
    setPreviewError(null);
    if (!scopeId || !route.file) return () => controller.abort();
    setPropertiesLoading(true);
    client
      .get("/metadata", { path: route.file }, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) return;
        setEntry(result);
        if (result.type === "file") {
          try {
            const value = await client.get(
              "/preview",
              { path: route.file },
              controller.signal,
            );
            if (!controller.signal.aborted) setPreview(value);
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
    return () => controller.abort();
  }, [client, scopeId, route.file]);

  const currentFavorite = preferences.preferences.favorites.find(
    (favorite) => favorite.path === path,
  );
  const updateFavorite = async () => {
    const favorites = currentFavorite
      ? preferences.preferences.favorites.filter(
          (favorite) => favorite.id !== currentFavorite.id,
        )
      : [
          ...preferences.preferences.favorites,
          {
            id: crypto.randomUUID(),
            name:
              path.split("/").filter(Boolean).at(-1) ||
              (context.kind === "project" ? copy.root : path),
            path,
          },
        ];
    await preferences.update({ favorites }).catch(() => {});
  };
  const showProperties = (selected) =>
    changeRoute({ file: selected.path, filePage: page });
  const openEntry = (selected) => {
    if (selected.type === "directory") goPath(selected.path);
    else showProperties(selected);
  };
  const openLink = async () => {
    setPreviewError(null);
    try {
      await client.get("/entries", {
        path: entry.path,
        page: 1,
        sort: "name",
        direction: "asc",
        hidden: hidden ? 1 : 0,
      });
      goPath(entry.path);
    } catch (issue) {
      if (issue.code !== "FILE_NOT_DIRECTORY") {
        setPreviewError(issue);
        return;
      }
      try {
        setPreview(await client.get("/preview", { path: entry.path }));
      } catch (previewIssue) {
        setPreviewError(previewIssue);
      }
    }
  };
  const refresh = () => {
    if (invalidPage) changeRoute({ filePage: 1, filePageInvalid: null, file: "" }, true);
    listing.refresh();
  };
  const directoryTree = context && (
    <DirectoryTree
      client={client}
      context={context}
      hidden={hidden}
      favorites={preferences.preferences.favorites}
      projects={projects}
      onNavigate={(nextPath) => {
        setTreeOpen(false);
        goPath(nextPath);
      }}
      onRemoveFavorite={(id) =>
        preferences
          .update({
            favorites: preferences.preferences.favorites.filter(
              (favorite) => favorite.id !== id,
            ),
          })
          .catch(() => {})
      }
      onClose={treeOpen ? () => setTreeOpen(false) : null}
    />
  );

  return (
    <section className="file-explorer" aria-label={copy.tab}>
      <h1>{copy.tab}</h1>
      <ErrorMessage error={contextError?.message} />
      {context && (
        <>
          <ExplorerToolbar
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
          />
          <ErrorMessage error={preferences.error?.message} />
          {invalidPage ? (
            <div className="explorer-page-error">
              <ErrorMessage error={copy.errors.FILE_INVALID_PAGE} />
              <button className="button secondary" onClick={refresh}>
                {copy.refresh}
              </button>
            </div>
          ) : (
            <div className="file-explorer-columns">
              <aside className="explorer-tree-column">{directoryTree}</aside>
              <div className="explorer-list-column">
                {listing.loading && !listing.listing && (
                  <p role="status">{copy.loading}</p>
                )}
                <ErrorMessage error={listing.error?.message} />
                {listing.error?.code === "FILE_SNAPSHOT_EXPIRED" && (
                  <button className="button secondary" onClick={refresh}>
                    {copy.refresh}
                  </button>
                )}
                {listing.listing && (
                  <>
                    <p className="field-description">
                      {copy.summary(listing.listing.total, listing.listing.page)}
                    </p>
                    <FileList
                      listing={listing.listing}
                      selected={route.file}
                      onOpen={openEntry}
                      onProperties={showProperties}
                      onPage={(filePage) => changeRoute({ filePage, file: "" })}
                    />
                    {kind === "project" && !context.readOnly && (
                      <CreateDirectory
                        key={path}
                        create={(name) =>
                          api(
                            `/sessions/${encodeURIComponent(sessionId)}/files`,
                            "POST",
                            { path, name },
                          )
                        }
                        created={goPath}
                      />
                    )}
                  </>
                )}
              </div>
              <FileProperties
                entry={entry}
                preview={preview}
                error={propertiesError}
                previewError={previewError}
                loading={propertiesLoading}
                onClose={() => changeRoute({ file: "", filePage: page })}
                onOpenLink={openLink}
              />
            </div>
          )}
          {treeOpen && (
            <Modal title={copy.directoryTree} close={() => setTreeOpen(false)}>
              {directoryTree}
            </Modal>
          )}
        </>
      )}
    </section>
  );
}
