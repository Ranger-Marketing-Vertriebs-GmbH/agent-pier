import React, { useEffect, useRef } from "react";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { assistantShellCopy as copy } from "../../lib/i18n/messages/assistant-shell.js";
import AssistantShellAllowlist from "./AssistantShellAllowlist.jsx";
import { shellEligible, shellLevels } from "./shell-level.js";
import "./assistant-shell.css";

/**
 * The agent's shell level. Raising it is confirmed in `confirmation` once the
 * server asks for it: "confirmShell" shows the warning, "confirmFull" the extra
 * no-prompts confirmation. Existing agents also list their allowed commands.
 */
export default function AssistantShell({
  assistant,
  shell,
  onChange,
  confirmation,
  busy,
  onConfirm,
  onCancel,
}) {
  const eligible = shellEligible(assistant);
  const reason = eligible ? "" : assistant?.archivedAt ? copy.archived : copy.temporary;
  const full = confirmation === "confirmFull";
  const dialog = useRef(null);
  // The save can come from the phone's save bar far below; bring the question to the owner.
  useEffect(() => {
    const element = dialog.current;
    if (!confirmation || !element) return;
    element.scrollIntoView?.({ block: "nearest" });
    element.querySelector("button")?.focus({ preventScroll: true });
  }, [confirmation]);
  return (
    <section id="agent-shell" className="assistant-anchor assistant-shell">
      {assistant && (
        <h2 className="assistant-section-title">{assistantCopy.sections.shell}</h2>
      )}
      <fieldset
        className="assistant-capability-options assistant-shell-levels"
        aria-describedby="agent-shell-intro"
      >
        <legend>{copy.title}</legend>
        <p id="agent-shell-intro" className="assistant-note">
          {reason || copy.intro}
        </p>
        {shellLevels.map((level) => (
          <label className="assistant-team-permission assistant-capability" key={level}>
            <input
              type="radio"
              name="agent-shell-level"
              value={level}
              checked={shell === level}
              disabled={!eligible || busy}
              aria-describedby={`agent-shell-${level}-hint`}
              onChange={() => onChange(level)}
            />
            <span>
              {copy.levels[level]}
              <small id={`agent-shell-${level}-hint`}>{copy.levelHints[level]}</small>
            </span>
          </label>
        ))}
        {eligible && (
          <p className={shell === "off" ? "assistant-note" : "assistant-shell-warning"}>
            {shell === "off" ? copy.offHint : copy.warning}
          </p>
        )}
        {eligible && assistant?.shellPending && (
          <p role="status" className="assistant-notice">
            {copy.pending}
          </p>
        )}
      </fieldset>
      {confirmation && (
        <div
          ref={dialog}
          className="assistant-restart-confirmation assistant-shell-confirmation"
          role="alertdialog"
          aria-label={full ? copy.fullTitle : copy.confirmTitle}
        >
          <strong>{full ? copy.fullTitle : copy.confirmTitle}</strong>
          <p>{full ? copy.fullBody : copy.warning}</p>
          <div className="assistant-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={onConfirm}
            >
              {full ? copy.confirmFull : copy.confirm}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={onCancel}
            >
              {copy.cancel}
            </button>
          </div>
        </div>
      )}
      {assistant && eligible && <AssistantShellAllowlist assistantId={assistant.id} />}
    </section>
  );
}
