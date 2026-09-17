import React, { useEffect, useState } from "react";
import Icon from "../../components/Icon.jsx";
import { explorerNavigationCopy as copy } from "../../lib/i18n/messages/explorer-navigation.js";
import "./explorer-toolbar.css";

function crumbs(path, project, rootLabel) {
  const parts = path.split("/").filter(Boolean);
  const values = [
    {
      label: project ? rootLabel || copy.root : "/",
      path: project ? "" : "/",
    },
  ];
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
  onSearch,
  searching,
  children,
  rootLabel,
}) {
  const [value, setValue] = useState(path);
  const [query, setQuery] = useState("");
  const [recursive, setRecursive] = useState(true);
  const [caseSensitive, setCaseSensitive] = useState(false);
  useEffect(() => setValue(path), [path]);
  return (
    <header className="explorer-toolbar">
      <div className="explorer-toolbar-primary">
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
        </div>
        <nav className="explorer-breadcrumbs" aria-label={copy.breadcrumbs}>
          {crumbs(path, project, rootLabel).map((crumb, index, values) => (
            <React.Fragment key={crumb.path}>
              {index > 0 && <span aria-hidden="true">/</span>}
              <button
                type="button"
                aria-current={index === values.length - 1 ? "location" : undefined}
                onClick={() => onPath(crumb.path)}
              >
                {crumb.label}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="explorer-toolbar-actions">
          <button
            type="button"
            className={`button secondary compact tree-toggle ${project ? "project-scope" : ""}`}
            aria-label={copy.openTree}
            onClick={onTree}
          >
            <Icon name="folder" />
            <span>{project ? copy.folders : copy.places}</span>
          </button>
          {children}
        </div>
      </div>
      <form
        className="explorer-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (query) onSearch({ query, recursive, caseSensitive, hidden });
        }}
      >
        <label className="explorer-search-field">
          <span>{copy.searchQuery}</span>
          <input
            type="search"
            maxLength={256}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className="button secondary compact" disabled={!query || searching}>
          {copy.search}
        </button>
        <details className="explorer-search-options">
          <summary>{copy.searchOptions}</summary>
          <div>
            <label>
              <input
                type="checkbox"
                checked={recursive}
                onChange={(event) => setRecursive(event.target.checked)}
              />
              {copy.recursive}
            </label>
            <label>
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(event) => setCaseSensitive(event.target.checked)}
              />
              {copy.caseSensitive}
            </label>
          </div>
        </details>
      </form>
      <div className="explorer-toolbar-disclosures">
        <details className="explorer-path-options">
          <summary>{copy.path}</summary>
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
        </details>
        <details className="explorer-view-disclosure">
          <summary>{copy.view}</summary>
          <div className="explorer-view-options">
            <label>
              {copy.sortBy}
              <select
                aria-label={copy.sortBy}
                value={sort}
                onChange={(event) => onSort(event.target.value)}
              >
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
        </details>
      </div>
    </header>
  );
}
