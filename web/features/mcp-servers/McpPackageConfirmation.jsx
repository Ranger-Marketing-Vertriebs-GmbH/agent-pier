import React, { useId, useState } from "react";
import { useAlertDialogFocus } from "../../components/useAlertDialogFocus.js";
import { mcpPackageCopy as copy } from "../../lib/i18n/messages/mcp-packages.js";
import { mcpServerCopy } from "../../lib/i18n/messages/mcp-servers.js";
import "./mcp-packages.css";

/** Nested copies of one package share name and version; their lock path tells them apart. */
const dependencyKey = (entry) => entry.path ?? `${entry.name}@${entry.version}`;
const shortIntegrity = (value) =>
  value && value.length > 24 ? `${value.slice(0, 24)}…` : value || "—";

/** Added, removed and changed packages of an update, with their versions. */
function LockDiff({ diff }) {
  const groups = [
    [copy.diffAdded, diff.added, (d) => `${d.name} ${d.version}`],
    [copy.diffRemoved, diff.removed, (d) => `${d.name} ${d.version}`],
    [copy.diffChanged, diff.changed, (d) => copy.diffChange(d.name, d.from, d.to)],
  ].filter(([, list]) => list?.length);
  return (
    <div className="mcp-package-diff">
      <strong>{copy.changesTitle}</strong>
      {groups.length ? (
        groups.map(([title, list, text]) => (
          <div key={title}>
            <span>{`${title} (${list.length})`}</span>
            <ul>
              {list.map((entry) => (
                <li key={dependencyKey(entry)}>{text(entry)}</li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <p className="mcp-hint">{copy.diffNone}</p>
      )}
    </div>
  );
}

/**
 * The one owner confirmation of a package install or update: what is installed from
 * where, its dependencies, the program when the package has several, the scripts
 * warning and, for an update, the lock diff. It replaces the stdio confirmation.
 */
export default function McpPackageConfirmation({
  preview,
  allowScripts,
  update = false,
  defaultProgram,
  busy = false,
  returnKey,
  onConfirm,
  onCancel,
}) {
  const focus = useAlertDialogFocus(onCancel, returnKey);
  const programId = useId();
  const programs = preview.programs || [];
  const [program, setProgram] = useState(
    programs.includes(defaultProgram) ? defaultProgram : programs[0] || null,
  );
  const title = update ? copy.updateTitle : copy.confirmTitle;
  const blocked = preview.needsScripts === true && !allowScripts;
  return (
    <div
      {...focus}
      className="mcp-confirmation mcp-package-confirmation"
      role="alertdialog"
      aria-label={title}
    >
      <strong>{title}</strong>
      <dl className="mcp-details">
        <dt>{copy.nameLabel}</dt>
        <dd>{`${preview.name}@${preview.version}`}</dd>
        <dt>{copy.registryLabel}</dt>
        <dd>{copy.registries[preview.registry] || preview.registry}</dd>
        <dt>{copy.integrity}</dt>
        <dd title={preview.integrity || undefined}>
          {shortIntegrity(preview.integrity)}
        </dd>
      </dl>
      <details className="mcp-package-dependencies">
        <summary>{copy.dependencies(preview.dependencyCount ?? 0)}</summary>
        <ul>
          {(preview.dependencies || []).map((entry) => (
            <li key={dependencyKey(entry)}>{`${entry.name} ${entry.version}`}</li>
          ))}
        </ul>
      </details>
      {programs.length > 1 && (
        <div className="mcp-field">
          <label htmlFor={programId}>{copy.programLabel}</label>
          <select
            id={programId}
            value={program || ""}
            onChange={(event) => setProgram(event.target.value)}
          >
            {programs.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
      {preview.diff && <LockDiff diff={preview.diff} />}
      {allowScripts && (
        <p className="mcp-warning">
          {copy.scriptsAllowed} {copy.allowScriptsWarning}
        </p>
      )}
      {blocked && (
        <p className="mcp-field-error" role="alert">
          {copy.needsScripts}
        </p>
      )}
      <p>{copy.confirmNote}</p>
      <div className="mcp-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy || blocked}
          onClick={() => onConfirm(programs.length > 1 ? program : null)}
        >
          {update ? copy.updateAction : copy.confirmAction}
        </button>
        <button
          type="button"
          className="button secondary"
          data-autofocus
          disabled={busy}
          onClick={onCancel}
        >
          {mcpServerCopy.cancel}
        </button>
      </div>
    </div>
  );
}
