import React, { useEffect, useId, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useLanguage from "../../lib/i18n/useLanguage.js";
import { mcpDirectoryCopy as directoryCopy } from "../../lib/i18n/messages/mcp-directory.js";
import { mcpPackageCopy as copy } from "../../lib/i18n/messages/mcp-packages.js";
import { serverText } from "../../lib/server-messages.js";
import { assistantApi } from "../assistants/assistant-api.js";
import McpPackageConfirmation from "./McpPackageConfirmation.jsx";
import McpPackageProgramChoice from "./McpPackageProgramChoice.jsx";
import {
  McpAllowScripts,
  McpConstraints,
  McpVersionPicker,
} from "./McpPackageFields.jsx";
import { refusalField } from "./mcp-package-labels.js";
import { newestStable } from "./mcp-package-versions.js";
import { constraintLines, sourceConstraints } from "./mcp-server-draft.js";
import useMcpPackageVersions from "./useMcpPackageVersions.js";
import usePackageStatus from "./usePackageStatus.js";
import "./mcp-packages.css";

/**
 * The package of a packaged server: its status (installing, ready, choosing, failed,
 * missing) with its program and PyPI constraints, the last error and the redacted job log,
 * the program choice when a build installed several, Reinstall when the install is gone
 * or failed, and an update that shows the lock
 * diff before it is confirmed; the update keeps the constraints unless edited. While a job
 * runs the status is polled; `onChanged` reloads the servers once it settles.
 * `listedVersion` (a newer version the MCP directory lists) is named and offered when the
 * registry's version list has it.
 */
export default function McpPackagePanel({ server, onChanged, listedVersion = "" }) {
  useLanguage();
  const id = useId();
  const { status, setStatus, error, setError, source, job, running, shown } =
    usePackageStatus(server, onChanged);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [version, setVersion] = useState("");
  const [versionChosen, setVersionChosen] = useState(false);
  const [allowScripts, setAllowScripts] = useState(source.allowScripts === true);
  const versions = useMcpPackageVersions(source.registry, source.name);
  const pypi = source.registry === "pypi";
  const stored = source.constraints || [];
  const storedText = stored.join("\n");
  const [constraints, setConstraints] = useState(storedText);
  const [constraintsError, setConstraintsError] = useState("");
  const [versionError, setVersionError] = useState("");
  // A finished update stores new constraints: the field starts from them again.
  useEffect(() => setConstraints(storedText), [storedText]);

  // The directory's listed version, else the newest stable one, is offered for an
  // update until the owner picks one.
  useEffect(() => {
    if (versionChosen || !versions.versions.length) return;
    if (versions.versions.some((entry) => entry.version === listedVersion))
      setVersion(listedVersion);
    else if (!version) setVersion(newestStable(versions));
  }, [versions, version, listedVersion, versionChosen]);

  const act = async (work) => {
    setBusy(true);
    setError("");
    setConstraintsError("");
    setVersionError("");
    try {
      await work();
    } catch (failure) {
      // A refused constraint or version is named at its field.
      const field = refusalField(failure, source.registry);
      if (field === "packageConstraints") setConstraintsError(failure.message);
      else if (field === "packageVersion") setVersionError(failure.message);
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const started = (result) =>
    setStatus((current) => ({ ...current, source, job: result?.job ?? null }));
  const checkUpdate = () =>
    act(async () =>
      setPreview(
        await assistantApi.previewMcpPackage({
          registry: source.registry,
          name: source.name,
          version,
          allowScripts,
          ...sourceConstraints(source.registry, constraints),
          serverId: server.id,
        }),
      ),
    );
  const confirmUpdate = (program) =>
    act(async () => {
      started(
        await assistantApi.updateMcpPackage(server.id, {
          version,
          allowScripts,
          ...sourceConstraints(source.registry, constraints),
          previewId: preview.previewId,
          confirmInstall: true,
          ...(program ? { program } : {}),
        }),
      );
      setPreview(null);
    });
  const reinstall = () =>
    act(async () => started(await assistantApi.reinstallMcpPackage(server.id)));
  const choose = (program) =>
    act(async () =>
      started(await assistantApi.chooseMcpPackageProgram(server.id, { program })),
    );
  const programs = status?.programs ?? [];
  const choosing = shown === "choosing";
  const unchanged =
    version === source.version &&
    allowScripts === (source.allowScripts === true) &&
    (!pypi || constraintLines(constraints).join("\n") === storedText);
  const failure = status?.error;
  return (
    <section className="mcp-item mcp-package" aria-label={copy.panelLabel}>
      <div className="mcp-item-head">
        <strong>{`${source.name}@${source.version}`}</strong>
        <span role="status" className={`mcp-badge mcp-package-status-${shown}`}>
          {copy.status[shown] || shown}
        </span>
      </div>
      {(source.program || (pypi && stored.length > 0)) && (
        <dl className="mcp-details">
          {source.program && (
            <>
              <dt>{copy.programLabel}</dt>
              <dd>{source.program}</dd>
            </>
          )}
          {pypi && stored.length > 0 && (
            <>
              <dt>{copy.constraintsTitle}</dt>
              <dd>
                <ul
                  className="mcp-package-constraints"
                  aria-label={copy.constraintsTitle}
                >
                  {stored.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
      )}
      {failure && (
        <p className="mcp-field-error" role="alert">
          {serverText(failure.message, failure.messageKey)}
        </p>
      )}
      {job?.log && (
        <details className="mcp-package-log">
          <summary>{copy.log}</summary>
          <pre>{job.log}</pre>
        </details>
      )}
      <ErrorMessage error={error} />
      {choosing && programs.length > 0 && (
        <McpPackageProgramChoice programs={programs} busy={busy} onChoose={choose} />
      )}
      {/* A choosing record whose program list is gone can only be built again. */}
      {(shown === "failed" ||
        shown === "missing" ||
        (choosing && status && programs.length === 0)) && (
        <div className="mcp-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={reinstall}
          >
            {copy.reinstall}
          </button>
        </div>
      )}
      {listedVersion &&
        versions.versions.some((entry) => entry.version === listedVersion) && (
          <p className="mcp-hint">{directoryCopy.listedVersion(listedVersion)}</p>
        )}
      {!running && !preview && !choosing && (
        <div className="mcp-package-update">
          <McpVersionPicker
            id={`${id}-update`}
            label={copy.updateLabel}
            versions={versions}
            value={version}
            installed={source.version}
            error={versionError}
            onChange={(next) => {
              setVersionError("");
              setVersionChosen(true);
              setVersion(next);
            }}
          />
          {pypi && (
            <McpConstraints
              id={`${id}-constraints`}
              value={constraints}
              error={constraintsError}
              onChange={(text) => {
                setConstraintsError("");
                setConstraints(text);
              }}
            />
          )}
          <McpAllowScripts
            checked={allowScripts}
            registry={source.registry}
            onChange={setAllowScripts}
          />
          <div className="mcp-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy || !version || unchanged}
              data-focus-key={`mcp-package-check-${server.id}`}
              onClick={checkUpdate}
            >
              {copy.checkUpdate}
            </button>
          </div>
        </div>
      )}
      {preview && (
        <McpPackageConfirmation
          update
          preview={preview}
          allowScripts={allowScripts}
          defaultProgram={source.program}
          busy={busy}
          returnKey={`mcp-package-check-${server.id}`}
          onConfirm={confirmUpdate}
          onCancel={() => setPreview(null)}
        />
      )}
    </section>
  );
}
