import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";
import ChatScrollToBottom from "../chat/ChatScrollToBottom.jsx";
import { enterKeyHint, sendHint, shouldSubmitOnEnter } from "../chat/enter-submit.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import ComposerOptions from "./ComposerOptions.jsx";
import AgentAttachmentTray from "./AgentAttachmentTray.jsx";
import useAgentAttachments from "./useAgentAttachments.js";
import { ACCEPT } from "./agent-attachment-upload.js";
import { assistantAttachmentsCopy as attachCopy } from "../../lib/i18n/messages/assistant-attachments.js";
import MemberMentionMenu from "./MemberMentionMenu.jsx";
import useMemberMention from "./useMemberMention.js";

const maxHeight = 6 * 22;
const optionsId = "assistant-composer-options";

// One rounded box (handoff 1d/2a/2d): the field grows to six lines; attachments, team
// permission and the keyboard hint sit behind "+"; Stop replaces Send while working.
// Files can also be pasted or dropped; `onFiles` reports how many are ready, and
// `onSubmit(event, ids)` resolves true once the message with them was accepted.
// A lead's composer offers its members after "@" (`mentionMembers`).
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
  onFiles,
  onStop,
  output,
  stick,
  scroll,
  mentionMembers = [],
}) {
  const mobile = useMobileLayout();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const field = useRef(null);
  const optionsButton = useRef(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef(null);
  const attachments = useAgentAttachments(conversationId);
  const ready = attachments.ids.join();
  const member = Boolean(assistant.teamMemberId);
  const hint = sendHint(touchInput);
  const reported = useRef(ready);
  const change = (value) => {
    setText(value);
    drafts.set(conversationId, value);
  };
  const mention = useMemberMention({
    members: member ? [] : mentionMembers,
    text,
    field,
    onText: change,
  });
  useEffect(() => {
    onFiles?.(ready ? ready.split(",").length : 0);
    // Different files make a different message: it needs its own delivery key.
    if (reported.current !== ready) drafts.attach?.(conversationId);
    reported.current = ready;
  }, [ready, onFiles, drafts, conversationId]);
  const attach = () => {
    setOptionsOpen(false);
    picker.current?.click();
  };
  const withFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  const submitWithFiles = async (event) => {
    event.preventDefault();
    if (attachments.blocked) return;
    if (await onSubmit(event, attachments.ids)) attachments.sent();
  };
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
      disabled={!canSend || attachments.blocked}
    >
      <Icon name="arrow" size={17} strokeWidth="2" />
    </button>
  );
  const toggle = (
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
  );
  return (
    <form
      className={`assistant-composer${member ? " member" : ""}${dragging ? " dragging" : ""}`}
      onSubmit={submitWithFiles}
      onDragOver={(event) => {
        if (!withFiles(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!withFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        attachments.add(event.dataTransfer.files);
      }}
    >
      <ChatScrollToBottom active output={output} stick={stick} scroll={scroll} />
      <ComposerOptions
        id={optionsId}
        open={optionsOpen}
        member={member}
        onAttach={attach}
        teamAllowed={teamAllowed}
        onTeamAllowed={allowTeam}
        hint={mobile && !member ? hint : ""}
        trigger={optionsButton}
        onClose={closeOptions}
      />
      {mention.enabled && <MemberMentionMenu mention={mention} />}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        aria-label={attachCopy.choose}
        onChange={(event) => {
          attachments.add(event.target.files);
          event.target.value = "";
        }}
      />
      <div className="assistant-composer-box">
        <AgentAttachmentTray attachments={attachments} />
        {member && toggle}
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
          {...(mention.enabled && {
            role: "combobox",
            "aria-autocomplete": "list",
            "aria-expanded": mention.open,
            "aria-controls": mention.listId,
            "aria-activedescendant": mention.open
              ? mention.optionId(mention.active)
              : undefined,
            onSelect: mention.sync,
          })}
          placeholder={
            member
              ? commonCopy.messagePlaceholder(assistant.name)
              : copy.messagePlaceholder
          }
          onPaste={(event) => {
            const files = event.clipboardData?.files;
            if (!files?.length) return;
            event.preventDefault();
            attachments.add(files);
          }}
          onKeyDown={(event) => {
            if (mention.onKeyDown(event)) return;
            if (!shouldSubmitOnEnter(event, touchInput)) return;
            event.preventDefault();
            if (!event.repeat) event.currentTarget.form.requestSubmit();
          }}
          onChange={(event) => {
            change(event.target.value);
            if (mention.enabled) mention.sync();
          }}
        />
        {member ? (
          submit
        ) : (
          <div className="assistant-composer-row">
            {toggle}
            {teamAllowed && (
              <button
                type="button"
                className="assistant-team-chip"
                onClick={() => allowTeam(false)}
              >
                <Icon name="users" size={13} strokeWidth="1.8" />
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
