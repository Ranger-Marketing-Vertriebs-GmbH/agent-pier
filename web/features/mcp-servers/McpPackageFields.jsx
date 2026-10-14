import React, { useEffect, useState } from "react";
import Segment from "../../components/Segment.jsx";
import { locale } from "../../lib/i18n/index.js";
import { mcpPackageCopy as copy } from "../../lib/i18n/messages/mcp-packages.js";
import { newestStable, versionOptions } from "./mcp-package-versions.js";
import useMcpPackageVersions from "./useMcpPackageVersions.js";
import "./mcp-packages.css";

/** "1.1.0 · 9/1/2026 · deprecated · installed" */
function optionLabel(entry, installed) {
  const date = entry.publishedAt
    ? new Date(entry.publishedAt).toLocaleDateString(locale)
    : "";
  return [
    date ? copy.versionAt(entry.version, date) : entry.version,
    entry.prerelease && copy.prerelease,
    entry.deprecated && copy.deprecated,
    entry.version === installed && copy.installed,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A package version, newest first; prereleases hide behind a toggle, deprecated ones
 * stay selectable and `installed` is marked. Loading and registry failures are named.
 */
export function McpVersionPicker({ id, label, versions, value, onChange, installed }) {
  const [showPrereleases, setShowPrereleases] = useState(false);
  const options = versionOptions(versions.versions, { showPrereleases, selected: value });
  const hint = versions.loading
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
        role="status"
        className={versions.failed ? "mcp-field-error" : "mcp-hint"}
      >
        {hint}
      </small>
    </div>
  );
}

/** The scripts opt-in; its warning shows as soon as it is checked. */
export function McpAllowScripts({ checked, onChange }) {
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
      {checked && <p className="mcp-warning">{copy.allowScriptsWarning}</p>}
    </>
  );
}

/** Registry, package and version of a package to install, with the scripts opt-in. */
export default function McpPackageFields({ formId, values, set }) {
  const versions = useMcpPackageVersions(values.registry, values.packageName);
  // The newest stable version is preselected; a version the package lacks goes.
  useEffect(() => {
    const listed = versions.versions.some((v) => v.version === values.packageVersion);
    if (versions.versions.length && !listed)
      set("packageVersion")(newestStable(versions));
    else if (versions.failed && values.packageVersion) set("packageVersion")("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions]);
  return (
    <>
      <div className="mcp-field">
        <span aria-hidden="true">{copy.registryLabel}</span>
        <Segment
          label={copy.registryLabel}
          value={values.registry}
          onChange={set("registry")}
          options={["npm"].map((value) => ({ value, label: copy.registries[value] }))}
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
          placeholder="@scope/server"
          onChange={(event) => set("packageName")(event.target.value)}
        />
      </label>
      <McpVersionPicker
        id={`${formId}-version`}
        label={copy.versionLabel}
        versions={versions}
        value={values.packageVersion}
        onChange={set("packageVersion")}
      />
      <McpAllowScripts checked={values.allowScripts} onChange={set("allowScripts")} />
    </>
  );
}
