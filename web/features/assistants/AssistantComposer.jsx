import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";
import ChatScrollToBottom from "../chat/ChatScrollToBottom.jsx";
import { enterKeyHint, sendHint, shouldSubmitOnEnter } from "../chat/enter-submit.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import ComposerOptions from "./ComposerOptions.jsx";

const maxHeight = 6 * 22;
const optionsId = "assistant-composer-options";

// One rounded box (handoff 1d/2a/2d): the field grows to six lines; team permission
// and the keyboard hint sit behind "+" on phones; Stop replaces Send while working.
export default function AssistantComposer({
  assistant,
  conversationId,
  drafts,
  text,
  setText,
  teamAllowed,
  setTeamAllowed,
  canSend,
  busy,
  active,
  touchInput,
  onSubmit,
  onStop,
  output,
  stick,
  scroll,
}) {
  const mobile = useMobileLayout();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const field = useRef(null);
  const optionsButton = useRef(null);
  const member = Boolean(assistant.teamMemberId);
  const hint = sendHint(touchInput);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
  }, [text]);
  const closeOptions = useCallback((restoreFocus) => {
    setOptionsOpen(false);
    if (restoreFocus) optionsButton.current?.focus();
  }, []);
  const allowTeam = (value) => {
    setTeamAllowed(value);
    drafts.allowTeam(conversationId, value);
  };
  const submit = active ? (
    <button
      type="button"
      className="assistant-stop"
      aria-label={copy.stop}
      onClick={onStop}
    >
      <Icon name="stop" size={12} fill />
      {copy.stopShort}
    </button>
  ) : (
    <button
      className="assistant-send"
      aria-label={copy.send}
      aria-busy={busy || undefined}
      disabled={!canSend}
    >
      <Icon name="arrow" size={17} strokeWidth="2" />
    </button>
  );
  return (
    <form className={`assistant-composer${member ? " member" : ""}`} onSubmit={onSubmit}>
      <ChatScrollToBottom active output={output} stick={stick} scroll={scroll} />
      {!member && (
        <ComposerOptions
          id={optionsId}
          open={optionsOpen}
          teamAllowed={teamAllowed}
          onTeamAllowed={allowTeam}
          hint={mobile ? hint : ""}
          trigger={optionsButton}
          onClose={closeOptions}
        />
      )}
      <div className="assistant-composer-box">
        <label className="sr-only" htmlFor="assistant-message">
          {copy.message}
        </label>
        <textarea
          ref={field}
          id="assistant-message"
          value={text}
          maxLength={65536}
          rows={1}
          enterKeyHint={enterKeyHint(touchInput)}
          placeholder={
            member
              ? commonCopy.messagePlaceholder(assistant.name)
              : copy.messagePlaceholder
          }
          onKeyDown={(event) => {
            if (!shouldSubmitOnEnter(event, touchInput)) return;
            event.preventDefault();
            if (!event.repeat) event.currentTarget.form.requestSubmit();
          }}
          onChange={(event) => {
            setText(event.target.value);
            drafts.set(conversationId, event.target.value);
          }}
        />
        {member ? (
          submit
        ) : (
          <div className="assistant-composer-row">
            <button
              ref={optionsButton}
              type="button"
              className={`assistant-options-toggle${optionsOpen ? " open" : ""}`}
              aria-label={optionsOpen ? copy.optionsClose : copy.options}
              aria-expanded={optionsOpen}
              aria-controls={optionsId}
              onClick={() => setOptionsOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !optionsOpen) return;
                event.stopPropagation();
                setOptionsOpen(false);
              }}
            >
              <Icon name={optionsOpen ? "close" : "plus"} size={optionsOpen ? 15 : 16} />
            </button>
            {teamAllowed && (
              <button
                type="button"
                className="assistant-team-chip"
                onClick={() => allowTeam(false)}
              >
                <Icon name="users" size={13} />
                {copy.team.allowedChip}
              </button>
            )}
            {!mobile && <span className="assistant-composer-hint">{hint}</span>}
            {submit}
          </div>
        )}
      </div>
    </form>
  );
}
