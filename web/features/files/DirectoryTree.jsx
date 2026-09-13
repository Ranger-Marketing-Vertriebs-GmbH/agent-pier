import React, { useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";

function TreeNode({ client, node, hidden, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const load = (page = 1, snapshot = null) => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    client
      .get(
        "/entries",
        {
          path: node.path,
          page,
          sort: "name",
          direction: "asc",
          hidden: hidden ? 1 : 0,
          ...(snapshot ? { snapshot } : {}),
        },
        controller.signal,
      )
      .then((result) =>
        setListing((current) => ({
          ...result,
          entries: [
            ...(page > 1 ? current?.entries || [] : []),
            ...result.entries.filter((entry) =>
              ["directory", "symlink"].includes(entry.type),
            ),
          ],
        })),
      )
      .catch(setError)
      .finally(() => setLoading(false));
    return () => controller.abort();
  };
  useEffect(() => {
    if (!open) return;
    setListing(null);
    return load();
    // A node reloads when hidden entries change; pagination is explicit below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, hidden, node.path, open]);
  return (
    <li>
      <div className="tree-node-row">
        <button
          type="button"
          className="tree-expand"
          aria-label={open ? copy.collapse(node.name) : copy.expand(node.name)}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="chevron" />
        </button>
        <button type="button" onClick={() => onNavigate(node.path)}>
          <Icon name={node.type === "symlink" ? "link" : "folder"} />
          <span>{node.name}</span>
        </button>
      </div>
      {open && (
        <div className="tree-children">
          {loading && !listing && <p role="status">{copy.loading}</p>}
          <ErrorMessage error={error?.message} />
          {listing && (
            <ul>
              {listing.entries.map((entry) => (
                <TreeNode
                  key={entry.path}
                  client={client}
                  node={entry}
                  hidden={hidden}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          )}
          {listing?.hasMore && (
            <button
              type="button"
              className="tree-more"
              disabled={loading}
              onClick={() => load(listing.page + 1, listing.snapshotId)}
            >
              {copy.moreFolders}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export default function DirectoryTree({
  client,
  context,
  hidden,
  favorites,
  projects,
  onNavigate,
  onRemoveFavorite,
  onClose,
}) {
  const root = {
    path: context.kind === "project" ? "" : context.root,
    name: context.kind === "project" ? copy.root : context.root,
    type: "directory",
  };
  return (
    <nav className="directory-tree" aria-label={copy.directoryTree}>
      {onClose && (
        <button type="button" className="button secondary compact" onClick={onClose}>
          {copy.closeTree}
        </button>
      )}
      <section>
        <h3>{copy.quickAccess}</h3>
        {!favorites.length && !projects.length && <p>{copy.noShortcuts}</p>}
        {favorites.map((item) => (
          <div className="tree-shortcut-row" key={`favorite:${item.id}`}>
            <button
              type="button"
              className="tree-shortcut"
              onClick={() => onNavigate(item.path)}
            >
              <Icon name="star" />
              <span>{item.name}</span>
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={copy.removeSavedFavorite(item.name)}
              onClick={() => onRemoveFavorite(item.id)}
            >
              <Icon name="close" />
            </button>
          </div>
        ))}
        {projects.map((item) => (
          <button
            type="button"
            className="tree-shortcut"
            key={`project:${item.id}`}
            onClick={() => onNavigate(item.path)}
          >
            <Icon name="folder" />
            <span>{item.name}</span>
          </button>
        ))}
      </section>
      <section>
        <h3>{copy.directoryTree}</h3>
        <ul className="tree-root">
          <TreeNode client={client} node={root} hidden={hidden} onNavigate={onNavigate} />
        </ul>
      </section>
    </nav>
  );
}
