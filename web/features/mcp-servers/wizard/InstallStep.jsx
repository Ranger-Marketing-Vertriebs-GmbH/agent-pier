import React, { useEffect, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { mcpPackageCopy } from "../../../lib/i18n/messages/mcp-packages.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { serverText } from "../../../lib/server-messages.js";
import { itemRoute } from "../../accounts/accounts-items.js";
import { assistantApi } from "../../assistants/assistant-api.js";
import McpPackageConfirmation from "../McpPackageConfirmation.jsx";
import McpPackageProgramChoice from "../McpPackageProgramChoice.jsx";
import { savedNotice } from "../mcp-notices.js";
import { secretCount, storedCount } from "./setting-hints.js";
import { previewNewPackage, refusedField, saveNewServer } from "./wizard-save.js";
import { stepOfField } from "./wizard-state.js";
import WizardStep from "./WizardStep.jsx";

function Progress({ server, packageStatus, dependencyCount, navigate }) {
  const { shown, status, job, setStatus } = packageStatus;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (work) => {
    setBusy(true);
    setError("");
    try {
      const result = await work();
      setStatus((current) => ({ ...current, job: result?.job ?? null }));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const failed = shown === "failed" || shown === "missing";
  const result = {
    ready: copy.install.installed,
    choosing: copy.install.choose,
    failed: copy.install.failed,
    missing: copy.install.failed,
  }[shown];
  return (
    <>
      <ol className="mcp-wizard-progress" aria-label={copy.install.progressTitle}>
        <li className="is-done">{copy.install.saved}</li>
        <li className={shown === "installing" ? "is-current" : "is-done"}>
          {copy.install.installing(dependencyCount)}
        </li>
        <li className={shown === "ready" ? "is-done" : ""}>
          {copy.install.checkingProgram}
        </li>
      </ol>
      <p role="status">{result ?? ""}</p>
      {status?.error && (
        <p className="mcp-field-error" role="alert">
          {serverText(status.error.message, status.error.messageKey)}
        </p>
      )}
      {job?.log && (
        <details className="mcp-package-log">
          <summary>{mcpPackageCopy.log}</summary>
          <pre>{job.log}</pre>
        </details>
      )}
      <ErrorMessage error={error} />
      {shown === "choosing" && (status?.programs ?? []).length > 0 && (
        <McpPackageProgramChoice
          programs={status.programs}
          busy={busy}
          onChoose={(program) =>
            act(() => assistantApi.chooseMcpPackageProgram(server.id, { program }))
          }
        />
      )}
      {failed && (
        <div className="mcp-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => act(() => assistantApi.reinstallMcpPackage(server.id))}
          >
            {copy.install.tryAgain}
          </button>
          <button
            type="button"
            className="button text"
            onClick={() => navigate(itemRoute("mcp-servers", server.id))}
          >
            {copy.install.changeVersion}
          </button>
        </div>
      )}
      {shown === "installing" && <p className="mcp-hint">{copy.install.background}</p>}
    </>
  );
}

/** Install (package path): the inline confirmation, then one save and the progress. */
export default function InstallStep({
  state,
  dispatch,
  go,
  headingRef,
  server,
  packageStatus,
  data,
  navigate,
  notifyMcp,
}) {
  const { draft } = state;
  const [preview, setPreview] = useState(null);
  const [checking, setChecking] = useState(!state.serverId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A refusal that names a field returns to the step that shows it, with its text.
  const refuse = (failure) => {
    const field = refusedField(failure, draft.registry);
    if (!field) return setError(failure.message);
    dispatch({ type: "refused", fieldError: field });
    go(stepOfField(state.path, field.field));
  };
  useEffect(() => {
    if (state.serverId) return undefined;
    let live = true;
    previewNewPackage({ draft })
      .then(
        (next) => live && setPreview(next),
        (failure) => live && refuse(failure),
      )
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const install = async (program) => {
    setBusy(true);
    setError("");
    try {
      const saved = await saveNewServer({
        draft,
        program,
        confirmations: { confirmInstall: true, previewId: preview.previewId },
      });
      await data.reloadMcp();
      notifyMcp(savedNotice(saved));
      dispatch({ type: "saved", id: saved.id });
    } catch (failure) {
      refuse(failure);
    } finally {
      setBusy(false);
    }
  };
  const shown = packageStatus.shown;
  const saved = Boolean(state.serverId);
  return (
    <WizardStep
      title={copy.install.title(draft.name)}
      headingRef={headingRef}
      busy={busy}
      primary={
        saved && server && !["failed", "missing"].includes(shown)
          ? { label: shown === "ready" ? copy.install.nextConnect : copy.continue }
          : undefined
      }
      onSubmit={() => go("connect")}
    >
      <p className="mcp-hint">
        {copy.install.summary(
          draft.name,
          storedCount(draft.env),
          secretCount(draft.env, draft.hints),
        )}
      </p>
      {checking && <p role="status">{copy.install.checking}</p>}
      <ErrorMessage error={error} />
      {!saved && preview && (
        <McpPackageConfirmation
          inline
          preview={preview}
          allowScripts={draft.allowScripts}
          defaultProgram={draft.hints.program}
          busy={busy}
          onConfirm={install}
          onCancel={() => go("package")}
        />
      )}
      {!saved && preview?.needsScripts && !draft.allowScripts && (
        <button type="button" className="button text" onClick={() => go("package")}>
          {copy.install.backToPackage}
        </button>
      )}
      {saved && server && (
        <Progress
          server={server}
          packageStatus={packageStatus}
          dependencyCount={preview?.dependencyCount ?? 0}
          navigate={navigate}
        />
      )}
    </WizardStep>
  );
}
