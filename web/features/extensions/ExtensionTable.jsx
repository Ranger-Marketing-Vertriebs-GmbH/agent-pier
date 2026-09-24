import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import { extensionsHubCopy as copy } from "../../lib/i18n/messages/extensions.js";

// Rows: { key, name, sub, mono, details, tag, status: { on, text }, actions }.
// On narrow screens the actions collapse behind a chevron per row.
export default function ExtensionTable({ heads, rows, empty }) {
  return (
    <div className="extension-table">
      <div className="extension-table-head" aria-hidden="true">
        <span>{heads[0]}</span>
        <span>{heads[1]}</span>
        <span>{heads[2]}</span>
        <span />
      </div>
      {rows.length ? (
        rows.map(({ key, ...row }) => <ExtensionRow key={key} {...row} />)
      ) : (
        <p className="extension-empty">{empty}</p>
      )}
    </div>
  );
}

function ExtensionRow({ name, label, sub, mono, details, tag, status, actions }) {
  const [open, setOpen] = useState(false);
  return (
    <article className={`extension-row${open ? " open" : ""}`}>
      <div className="extension-row-main">
        <h3>{name}</h3>
        {sub && <p className={mono ? "extension-row-mono" : ""}>{sub}</p>}
        {details}
      </div>
      <div className="extension-row-tag">
        {tag && <span className="extension-tag">{tag}</span>}
      </div>
      <div className="extension-row-status">
        {status && (
          <span className={`extension-status${status.on ? " on" : ""}`}>
            <i aria-hidden="true" />
            {status.text}
          </span>
        )}
      </div>
      {actions && (
        <>
          <div className="extension-row-actions">{actions}</div>
          <button
            type="button"
            className="icon-button extension-row-toggle"
            aria-expanded={open}
            aria-label={copy.rowActions(label || name)}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name="chevron" size={16} />
          </button>
        </>
      )}
    </article>
  );
}

export function ExtensionHint({ children, className = "" }) {
  return (
    <div className={["extension-hint", className].filter(Boolean).join(" ")}>
      <Icon name="info" size={15} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
