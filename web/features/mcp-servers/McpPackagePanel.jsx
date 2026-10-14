import React, { useEffect, useId, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useLanguage from "../../lib/i18n/useLanguage.js";
import { mcpPackageCopy as copy } from "../../lib/i18n/messages/mcp-packages.js";
import { serverText } from "../../lib/server-messages.js";
import { assistantApi } from "../assistants/assistant-api.js";
import McpPackageConfirmation from "./McpPackageConfirmation.jsx";
import { McpAllowScripts, McpVersionPicker } from "./McpPackageFields.jsx";
import { newestStable } from "./mcp-package-versions.js";
import useMcpPackageVersions from "./useMcpPackageVersions.js";
import "./mcp-packages.css";

const pollMs = 2000;

/**
 * The package of a packaged server: its status (installing, ready, failed, missing)
 * with the last error and the redacted job log, Reinstall when the install is gone or
 * failed, and an update that shows the lock diff before it is confirmed. While a job
 * runs the status is polled; `onChanged` reloads the servers once it settles.
 */
export default function McpPackagePanel({ server, onChanged }) {
  useLanguage();
  const id = useId();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const source = status?.source ?? server.source;
  const [version, setVersion] = useState("");
  const [allowScripts, setAllowScripts] = useState(source.allowScripts === true);
  const versions = useMcpPackageVersions(source.registry, source.name);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const job = status?.job ?? null;
  const running = source.status === "installing" || job?.state === "running";
  const shown = job?.state === "running" ? "installing" : source.status;

  useEffect(() => {
    let live = true;
    assistantApi
      .mcpPackageStatus(server.id)
      .then((next) => live && setStatus(next))
      .catch((failure) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [server.id, server.revision, server.source.status]);

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      assistantApi.mcpPackageStatus(server.id).then(
        (next) => {
          setStatus(next);
          if (next.source?.status !== "installing" && next.job?.state !== "running")
            changed.current?.();
        },
        () => {},
      );
    }, pollMs);
    return () => clearInterval(timer);
  }, [running, server.id]);

  // The newest stable version is offered for an update.
  useEffect(() => {
    if (!version && versions.versions.length) setVersion(newestStable(versions));
  }, [versions, version]);

  const act = async (work) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(failure.message);
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
          previewId: preview.previewId,
          confirmInstall: true,
          ...(program ? { program } : {}),
        }),
      );
      setPreview(null);
    });
  const reinstall = () =>
    act(async () => started(await assistantApi.reinstallMcpPackage(server.id)));
  const unchanged =
    version === source.version && allowScripts === (source.allowScripts === true);
  const failure = status?.error;
  return (
    <section className="mcp-item mcp-package" aria-label={copy.panelLabel}>
      <div className="mcp-item-head">
        <strong>{`${source.name}@${source.version}`}</strong>
        <span role="status" className={`mcp-badge mcp-package-status-${shown}`}>
          {copy.status[shown] || shown}
        </span>
      </div>
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
      {(shown === "failed" || shown === "missing") && (
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
      {!running && !preview && (
        <div className="mcp-package-update">
          <McpVersionPicker
            id={`${id}-update`}
            label={copy.updateLabel}
            versions={versions}
            value={version}
            installed={source.version}
            onChange={setVersion}
          />
          <McpAllowScripts checked={allowScripts} onChange={setAllowScripts} />
          <div className="mcp-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy || !version || unchanged}
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
          onConfirm={confirmUpdate}
          onCancel={() => setPreview(null)}
        />
      )}
    </section>
  );
}
