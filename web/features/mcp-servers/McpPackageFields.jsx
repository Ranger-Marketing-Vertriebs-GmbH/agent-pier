import React, { useEffect, useState } from "react";
import Segment from "../../components/Segment.jsx";
import { locale } from "../../lib/i18n/index.js";
import { mcpPackageCopy as copy } from "../../lib/i18n/messages/mcp-packages.js";
import { newestStable, versionOptions } from "./mcp-package-versions.js";
import useMcpPackageVersions from "./useMcpPackageVersions.js";
import "./mcp-packages.css";

/** "1.1.0 · 9/1/2026 · deprecated · installed"; a yanked PyPI release is marked too. */
function optionLabel(entry, installed) {
  const date = entry.publishedAt
    ? new Date(entry.publishedAt).toLocaleDateString(locale)
    : "";
  return [
    date ? copy.versionAt(entry.version, date) : entry.version,
    entry.prerelease && copy.prerelease,
    entry.deprecated && copy.deprecated,
    entry.yanked && copy.yanked,
    entry.version === installed && copy.installed,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A package version, newest first; prereleases hide behind a toggle, deprecated and
 * yanked ones stay selectable and `installed` is marked. Loading and registry failures are named.
 */
export function McpVersionPicker({
  id,
  label,
  versions,
  value,
  onChange,
  installed,
  error,
}) {
  const [showPrereleases, setShowPrereleases] = useState(false);
  const options = versionOptions(versions.versions, { showPrereleases, selected: value });
  const hint = error
    ? error
    : versions.loading
      ? copy.versionsLoading
      : versions.failed
        ? versions.error || copy.versionsUnavailable
        : "";
  return (
    <div className="mcp-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      >
        {!options.some((entry) => entry.version === value) && (
          <option value={value} disabled>
            {value || "—"}
          </option>
        )}
        {options.map((entry) => (
          <option key={entry.version} value={entry.version}>
            {optionLabel(entry, installed)}
          </option>
        ))}
      </select>
      <label className="mcp-check">
        <input
          type="checkbox"
          checked={showPrereleases}
          onChange={(event) => setShowPrereleases(event.target.checked)}
        />
        <span>{copy.showPrereleases}</span>
      </label>
      <small
        id={`${id}-hint`}
        role={error ? "alert" : "status"}
        className={error || versions.failed ? "mcp-field-error" : "mcp-hint"}
      >
        {hint}
      </small>
    </div>
  );
}

/**
 * The scripts opt-in; its warning shows as soon as it is checked. For PyPI it names
 * the build tools a source build fetches outside the hash-checked list (D6).
 */
export function McpAllowScripts({ checked, onChange, registry }) {
  return (
    <>
      <label className="mcp-check">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{copy.allowScripts}</span>
      </label>
      {checked && (
        <p className="mcp-warning">
          {copy.allowScriptsWarning}
          {registry === "pypi" && ` ${copy.buildToolsNote}`}
        </p>
      )}
    </>
  );
}

/**
 * Dependency constraints of a PyPI source (D4), one per line. `error` is the
 * server's refusal, shown at the field.
 */
export function McpConstraints({ id, value, onChange, error }) {
  const errorId = `${id}-error`;
  return (
    <div className="mcp-field">
      <label htmlFor={id}>{copy.constraintsLabel}</label>
      <textarea
        id={id}
        rows={2}
        value={value}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${errorId} ${id}-hint` : `${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && (
        <small id={errorId} role="alert" className="mcp-field-error">
          {error}
        </small>
      )}
      <small id={`${id}-hint`} className="mcp-hint">
        {copy.constraintsHint}
      </small>
    </div>
  );
}

/**
 * Registry, package and version of a package to install, with the scripts opt-in
 * and, for PyPI, its dependency constraints. A caller that shows the lookup itself
 * passes its `versions` list and `lookup` line; `collapsed` folds the options.
 */
export default function McpPackageFields({
  formId,
  values,
  set,
  constraintsError,
  versionError,
  versions: shared,
  collapsed = false,
  moreLabel = "",
  lookup = null,
}) {
  // A caller with its own list skips this request (an empty name fetches nothing).
  const own = useMcpPackageVersions(values.registry, shared ? "" : values.packageName);
  const versions = shared ?? own;
  // The newest stable version is preselected; a version the package lacks goes.
  useEffect(() => {
    const listed = versions.versions.some((v) => v.version === values.packageVersion);
    if (versions.versions.length && !listed)
      set("packageVersion")(newestStable(versions));
    else if (versions.failed && values.packageVersion) set("packageVersion")("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions]);
  const options = (
    <>
      {values.registry === "pypi" && (
        <McpConstraints
          id={`${formId}-constraints`}
          value={values.packageConstraints}
          error={constraintsError}
          onChange={set("packageConstraints")}
        />
      )}
      <McpAllowScripts
        checked={values.allowScripts}
        registry={values.registry}
        onChange={set("allowScripts")}
      />
    </>
  );
  return (
    <>
      <div className="mcp-field">
        <span aria-hidden="true">{copy.registryLabel}</span>
        <Segment
          label={copy.registryLabel}
          value={values.registry}
          onChange={(registry) => {
            set("registry")(registry);
            // A version belongs to one registry's package.
            set("packageVersion")("");
          }}
          options={["npm", "pypi"].map((value) => ({
            value,
            label: copy.registries[value],
          }))}
        />
      </div>
      <label>
        {copy.nameLabel}
        <input
          value={values.packageName}
          required
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          placeholder={copy.namePlaceholder[values.registry] ?? copy.namePlaceholder.npm}
          onChange={(event) => {
            set("packageName")(event.target.value);
            // A version belongs to one package; the new list preselects again.
            set("packageVersion")("");
          }}
        />
      </label>
      {lookup}
      <McpVersionPicker
        id={`${formId}-version`}
        label={copy.versionLabel}
        versions={versions}
        value={values.packageVersion}
        error={versionError}
        onChange={set("packageVersion")}
      />
      {collapsed ? (
        <details className="mcp-advanced" open={Boolean(constraintsError)}>
          <summary>{moreLabel}</summary>
          {options}
        </details>
      ) : (
        options
      )}
    </>
  );
}
