import React from "react";
import "./page-header.css";

/**
 * The header of an overview page with a wide content column, such as the start page:
 * an eyebrow line, the title (the page's one `h1`), a summary line and the page's
 * actions beside it (below it on phones, as full-width buttons). Settings-like pages
 * use `SettingsShell` instead.
 */
export default function PageHeader({ eyebrow, title, summary, actions, className = "" }) {
  return (
    <header className={["page-header", className].filter(Boolean).join(" ")}>
      <div className="page-header-text">
        {eyebrow && <p className="page-header-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {summary && <div className="page-header-summary">{summary}</div>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
