import React, { useId, useState } from "react";
import Sheet from "../../../components/Sheet.jsx";
import SidePanel from "../../../components/SidePanel.jsx";
import { locale } from "../../../lib/i18n/index.js";
import { mcpDirectoryCopy as copy } from "../../../lib/i18n/messages/mcp-directory.js";
import useNarrowViewport from "../../accounts/useNarrowViewport.js";
import { linkLabel } from "./PackageStep.jsx";
import CuratedHint from "./CuratedHint.jsx";
import { optionChip } from "./DirectoryResult.jsx";
import { isSelectable } from "./directory-draft.js";

// Only http(s) links are shown; the label is host + path, never the raw address.
const safeLink = (url) => {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
};

const day = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(locale);
};

function Body({ entry, chosen, setChosen }) {
  const id = useId();
  const option = entry.options[chosen];
  const inputs = option
    ? [...(option.env ?? []), ...(option.headers ?? []), ...(option.urlVariables ?? [])]
    : [];
  const marked = inputs.some((item) => item.required);
  const published = entry.publishedAt ? day(entry.publishedAt) : "";
  return (
    <div className="mcp-directory-detail">
      <p className="mcp-hint">
        <span className="mcp-wizard-mono">{entry.namespace}</span> · {copy.verified}
      </p>
      <p className="mcp-hint">{copy.verifiedHint}</p>
      <p className="mcp-hint">
        {copy.status[entry.status] ?? entry.status}
        {published && ` · ${copy.published(published)}`}
      </p>
      {entry.statusMessage && <p className="mcp-warning">{entry.statusMessage}</p>}
      {entry.description && <p className="mcp-directory-text">{entry.description}</p>}
      <CuratedHint serverName={entry.name} />
      {[
        ["repositoryUrl", copy.sourceLink],
        ["websiteUrl", copy.website],
      ].map(([key, label]) => {
        const href = safeLink(entry[key]);
        return (
          href && (
            <p key={key} className="mcp-hint">
              <a href={href} target="_blank" rel="noopener noreferrer">
                {label(linkLabel(href))}
              </a>{" "}
              <small>{copy.linkNote}</small>
            </p>
          )
        );
      })}
      <fieldset className="mcp-wizard-cards">
        <legend className="mcp-wizard-subtitle">{copy.howItRuns}</legend>
        {entry.options.map((item, index) => (
          <label
            key={index}
            className={`mcp-wizard-card${isSelectable(item) ? "" : " is-disabled"}`}
          >
            <input
              type="radio"
              name={`${id}-way`}
              disabled={!isSelectable(item)}
              checked={index === chosen}
              onChange={() => setChosen(index)}
            />
            <span className="mcp-wizard-card-title">
              {optionChip(item)}
              {item.identifier && (
                <span className="mcp-wizard-mono"> {item.identifier}</span>
              )}
            </span>
            {!isSelectable(item) && (
              <small className="mcp-hint">{copy.reasons[item.unsupportedReason]}</small>
            )}
          </label>
        ))}
      </fieldset>
      <section aria-labelledby={`${id}-settings`}>
        <h3 id={`${id}-settings`} className="mcp-wizard-subtitle">
          {copy.settingsNeeded}
        </h3>
        {!marked && <p className="mcp-hint">{copy.noSettingsMarked}</p>}
        <ul className="mcp-wizard-notes">
          {inputs.map((item, index) => (
            <li key={`${item.name}-${index}`}>
              <code className="mcp-wizard-mono">{item.name}</code>
              {item.required && <span className="list-row-pill">{copy.required}</span>}
              {item.secret && <span className="list-row-pill">{copy.secret}</span>}
              {item.description && <span className="mcp-hint"> {item.description}</span>}
            </li>
          ))}
        </ul>
      </section>
      <p className="mcp-hint">{copy.reviewNote}</p>
    </div>
  );
}

function Detail({ entry, onUse, onClose }) {
  const narrow = useNarrowViewport();
  const [chosen, setChosen] = useState(() => entry.options.findIndex(isSelectable));
  const option = entry.options[chosen];
  const title = entry.title || entry.name;
  const use = (
    <button
      type="button"
      className="button primary"
      disabled={!option || !isSelectable(option)}
      onClick={() => onUse(option)}
    >
      {copy.use}
    </button>
  );
  const body = <Body entry={entry} chosen={chosen} setChosen={setChosen} />;
  return narrow ? (
    <Sheet open title={title} onCancel={onClose} className="mcp-directory-sheet">
      {body}
      <div className="sheet-actions">
        {use}
        <button type="button" className="button text" onClick={onClose}>
          {copy.detailClose}
        </button>
      </div>
    </Sheet>
  ) : (
    <SidePanel title={title} close={onClose} cancelLabel={copy.detailClose} footer={use}>
      {body}
    </SidePanel>
  );
}

/** The entry's detail: a sheet on phones, a side panel on wider screens. */
export default function DirectoryDetail({ entry, onUse, onClose }) {
  if (!entry) return null;
  return <Detail key={entry.name} entry={entry} onUse={onUse} onClose={onClose} />;
}
