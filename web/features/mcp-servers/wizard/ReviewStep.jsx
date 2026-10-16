import React, { useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { mcpServerCopy } from "../../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { savedNotice } from "../mcp-notices.js";
import { storedCount } from "./setting-hints.js";
import { refusedField, saveNewServer } from "./wizard-save.js";
import { stepOfField } from "./wizard-state.js";
import WizardStep from "./WizardStep.jsx";

/** Review (address and own-command paths): one card, then one save without CLIs. */
export default function ReviewStep({ state, dispatch, go, headingRef, data, notifyMcp }) {
  const { draft, path } = state;
  const stdio = path === "command";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rows = stdio ? draft.env : draft.headers;
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      // "Allow and save" is the owner's stdio confirmation for this server.
      const saved = await saveNewServer({
        draft,
        confirmations: stdio ? { confirmStdio: true } : {},
      });
      await data.reloadMcp();
      notifyMcp(savedNotice(saved));
      dispatch({ type: "saved", id: saved.id });
      go("connect");
    } catch (failure) {
      const field = refusedField(failure, draft.registry);
      if (!field) return setError(failure.message);
      dispatch({ type: "refused", fieldError: field });
      go(stepOfField(path, field.field));
    } finally {
      setBusy(false);
    }
  };
  return (
    <WizardStep
      title={copy.review.title}
      headingRef={headingRef}
      busy={busy}
      primary={{ label: stdio ? copy.review.allowAndSave : copy.review.save }}
      onSubmit={save}
    >
      <dl className="mcp-details mcp-wizard-review">
        <dt>{copy.review.name}</dt>
        <dd>{draft.name}</dd>
        <dt>{stdio ? copy.review.command : copy.review.address}</dt>
        <dd className="mcp-wizard-mono">{stdio ? draft.command : draft.url}</dd>
        {!stdio && (
          <>
            <dt>{copy.review.signIn}</dt>
            <dd>{copy.remote.signIns[draft.signIn]}</dd>
          </>
        )}
        <dt>{copy.review.settings}</dt>
        <dd>{copy.review.settingsCount(storedCount(rows))}</dd>
      </dl>
      {stdio && (
        <section
          className="mcp-confirmation"
          aria-label={mcpServerCopy.stdioWarningTitle}
        >
          <strong>{mcpServerCopy.stdioWarningTitle}</strong>
          <p>{mcpServerCopy.stdioWarning}</p>
        </section>
      )}
      <ErrorMessage error={error} />
    </WizardStep>
  );
}
