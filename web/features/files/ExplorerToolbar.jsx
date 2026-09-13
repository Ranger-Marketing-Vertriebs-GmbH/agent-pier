import React, { useEffect, useState } from "react";
import Icon from "../../components/Icon.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";

function crumbs(path, project) {
  const parts = path.split("/").filter(Boolean);
  const values = [{ label: project ? copy.root : "/", path: project ? "" : "/" }];
  for (let index = 0; index < parts.length; index++)
    values.push({
      label: parts[index],
      path: `${project ? "" : "/"}${parts.slice(0, index + 1).join("/")}`,
    });
  return values;
}

export default function ExplorerToolbar({
  path,
  project,
  parent,
  sort,
  direction,
  hidden,
  favorite,
  busy,
  onPath,
  onSort,
  onDirection,
  onHidden,
  onFavorite,
  onRefresh,
  onTree,
}) {
  const [value, setValue] = useState(path);
  useEffect(() => setValue(path), [path]);
  return (
    <header className="explorer-toolbar">
      <div className="explorer-history">
        <button
          type="button"
          className="icon-button"
          aria-label={copy.back}
          onClick={() => history.back()}
        >
          <Icon name="back" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={copy.forward}
          onClick={() => history.forward()}
        >
          <Icon name="arrow" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={copy.up}
          disabled={parent === null}
          onClick={() => parent !== null && onPath(parent)}
        >
          <Icon name="up" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={copy.refresh}
          onClick={onRefresh}
        >
          <Icon name="refresh" />
        </button>
        <button
          type="button"
          className="button secondary compact tree-toggle"
          onClick={onTree}
        >
          {copy.openTree}
        </button>
      </div>
      <form
        className="explorer-path-form"
        onSubmit={(event) => {
          event.preventDefault();
          onPath(value);
        }}
      >
        <label>
          <span>{copy.path}</span>
          <input
            aria-label={copy.path}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <button className="button secondary compact">{copy.go}</button>
      </form>
      <nav className="explorer-breadcrumbs" aria-label={copy.breadcrumbs}>
        {crumbs(path, project).map((crumb) => (
          <button type="button" key={crumb.path} onClick={() => onPath(crumb.path)}>
            {crumb.label}
          </button>
        ))}
      </nav>
      <div className="explorer-view-options">
        <label>
          {copy.sortBy}
          <select value={sort} onChange={(event) => onSort(event.target.value)}>
            <option value="name">{copy.sorts.name}</option>
            <option value="type">{copy.sorts.type}</option>
            <option value="size">{copy.sorts.size}</option>
            <option value="modifiedAt">{copy.sorts.modifiedAt}</option>
          </select>
        </label>
        <button
          type="button"
          className="button secondary compact"
          onClick={() => onDirection(direction === "asc" ? "desc" : "asc")}
        >
          {direction === "asc" ? copy.ascending : copy.descending}
        </button>
        <label className="explorer-hidden-toggle">
          <input
            type="checkbox"
            checked={hidden}
            disabled={busy}
            onChange={(event) => onHidden(event.target.checked)}
          />
          {copy.showHidden}
        </label>
        <button
          type="button"
          className="button secondary compact"
          disabled={busy}
          onClick={onFavorite}
        >
          {favorite ? copy.removeFavorite : copy.addFavorite}
        </button>
      </div>
    </header>
  );
}
