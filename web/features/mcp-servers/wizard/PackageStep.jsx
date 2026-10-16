import React, { useEffect, useId, useState } from "react";
import { locale } from "../../../lib/i18n/index.js";
import { mcpDirectoryCopy as directoryCopy } from "../../../lib/i18n/messages/mcp-directory.js";
import { mcpPackageCopy } from "../../../lib/i18n/messages/mcp-packages.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import McpPackageFields from "../McpPackageFields.jsx";
import NameField from "../NameField.jsx";
import { fieldErrors } from "../field-errors.js";
import { newestStable } from "../mcp-package-versions.js";
import useMcpPackageVersions from "../useMcpPackageVersions.js";
import { sanitiseName, uniqueName } from "./server-name.js";
import WizardStep from "./WizardStep.jsx";

/** "github.com/o/r" for a link: host and path as text, never the raw address. */
export const linkLabel = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "";
  }
};

function Lookup({ name, registry, versions }) {
  if (!name.trim() || versions.loading || versions.failed || !versions.versions.length)
    return null;
  const newest = newestStable(versions);
  const entry = versions.versions.find((item) => item.version === newest);
  const date = entry?.publishedAt
    ? new Date(entry.publishedAt).toLocaleDateString(locale)
    : "";
  const registryName = mcpPackageCopy.registries[registry] ?? registry;
  return (
    <div className="mcp-package-lookup">
      <p className="mcp-hint">
        {date
          ? copy.package.found(name.trim(), newest, date)
          : copy.package.foundUndated(name.trim(), newest)}
      </p>
      {versions.publisher && (
        <p className="mcp-hint">
          {copy.package.publishedBy(versions.publisher, registryName)}
        </p>
      )}
      {versions.repositoryUrl && (
        <p className="mcp-hint">
          <a href={versions.repositoryUrl} target="_blank" rel="noopener noreferrer">
            {copy.package.sourceLink(linkLabel(versions.repositoryUrl))}
          </a>{" "}
          <small>{copy.package.linkNote}</small>
        </p>
      )}
      <p className="mcp-hint">{copy.package.checkPublisher}</p>
    </div>
  );
}

export default function PackageStep({ state, dispatch, go, headingRef, data }) {
  const formId = useId();
  const { draft, fieldError } = state;
  const set = (key) => (value) => dispatch({ type: "set", key, value });
  const { errorId, errorOf } = fieldErrors(formId, fieldError);
  const versions = useMcpPackageVersions(draft.registry, draft.packageName);
  // The name follows the package until the owner types one.
  const [named, setNamed] = useState(Boolean(draft.name));
  useEffect(() => {
    if (named) return;
    const base = sanitiseName(draft.packageName.split("/").pop());
    const taken = (data.mcpServers || []).map((server) => server.name);
    set("name")(base ? uniqueName(base, taken) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.packageName]);
  const chosen = versions.versions.find((item) => item.version === draft.packageVersion);
  return (
    <WizardStep
      title={copy.package.title}
      headingRef={headingRef}
      primary={{ label: copy.continue }}
      onSubmit={() => go("settings")}
    >
      {draft.hints.directory && (
        <div className="mcp-wizard-notice">
          <p>
            {directoryCopy.listedAs(
              draft.hints.directory.name,
              draft.hints.directory.version,
            )}
          </p>
          <label className="mcp-check">
            <input
              type="checkbox"
              checked={draft.hints.useDirectory !== false}
              onChange={(event) =>
                set("hints")({ ...draft.hints, useDirectory: event.target.checked })
              }
            />
            <span>{directoryCopy.useHints}</span>
          </label>
        </div>
      )}
      <McpPackageFields
        formId={formId}
        values={draft}
        set={set}
        versions={versions}
        collapsed
        moreLabel={copy.package.moreOptions}
        constraintsError={errorOf("packageConstraints")}
        versionError={errorOf("packageVersion")}
        lookup={
          <Lookup
            name={draft.packageName}
            registry={draft.registry}
            versions={versions}
          />
        }
      />
      {chosen?.deprecated && <p className="mcp-warning">{copy.package.deprecated}</p>}
      {chosen?.yanked && <p className="mcp-warning">{copy.package.yanked}</p>}
      <NameField
        id={`${formId}-name`}
        value={draft.name}
        error={errorOf("name")}
        errorId={errorId}
        onChange={(value) => {
          setNamed(true);
          set("name")(value);
        }}
      />
    </WizardStep>
  );
}
