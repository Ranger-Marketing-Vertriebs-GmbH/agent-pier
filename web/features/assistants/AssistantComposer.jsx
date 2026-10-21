import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";
import ChatScrollToBottom from "../chat/ChatScrollToBottom.jsx";
import { enterKeyHint, sendHint, shouldSubmitOnEnter } from "../chat/enter-submit.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import ComposerOptions from "./ComposerOptions.jsx";
import QueuedMessage from "./QueuedMessage.jsx";
import AgentAttachmentTray from "./AgentAttachmentTray.jsx";
import { ACCEPT } from "./agent-attachment-upload.js";
import { assistantAttachmentsCopy as attachCopy } from "../../lib/i18n/messages/assistant-attachments.js";
import MemberMentionMenu from "./MemberMentionMenu.jsx";
import useMemberMention from "./useMemberMention.js";
import DictationButton from "../dictation/DictationButton.jsx";

const maxHeight = 6 * 22;
const optionsId = "assistant-composer-options";

// One rounded box (handoff 1d/2a/2d): the field grows to six lines; attachments, team
// permission and the keyboard hint sit behind "+"; Stop replaces Send while working.
// Meanwhile, and while a queued message still waits, Enter and "Send when done" queue
// the message on the server (`queued`, shown above the field until it is sent or
// taken back with `onTakeBack`); only Stop stops the turn.
// Files can also be pasted (dropping is handled by the chat panel, which owns
// `attachments`); `onFiles` reports how many are ready, and
// `onSubmit(event, ids)` resolves true once the message with them was accepted.
// A lead's composer offers its members after "@" (`mentionMembers`). Without `team`
// (a restricted user's chat) the one-message team permission is not offered.
export default function AssistantComposer({
  assistant,
  conversationId,
  drafts,
  attachments,
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
  queued,
  available,
  onTakeBack,
  output,
  stick,
  scroll,
  mentionMembers = [],
  team = true,
}) {
  const mobile = useMobileLayout();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const field = useRef(null);
  const optionsButton = useRef(null);
  const picker = useRef(null);
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
  const submitWithFiles = async (event) => {
    event.preventDefault();
    // A button that sent stays out of the way: the next Enter belongs to the field,
    // never to the Stop button taking the Send button's place.
    if (!touchInput && event.nativeEvent.submitter) field.current?.focus();
    if (attachments.blocked) return;
    const ids = attachments.ids;
    if (await onSubmit(event, ids)) attachments.sent(ids);
  };
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    // Collapsing the field to measure it briefly grows the transcript. WebKit clamps
    // its scrollTop then and has no scroll anchoring to undo it, so the newest lines
    // would stay hidden behind the composer.
    const transcript = output.current;
    const top = transcript?.scrollTop;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
    if (transcript) transcript.scrollTop = stick.current ? transcript.scrollHeight : top;
  }, [text, output, stick]);
  const closeOptions = useCallback((restoreFocus) => {
    setOptionsOpen(false);
    if (restoreFocus) optionsButton.current?.focus();
  }, []);
  const allowTeam = (value) => {
    setTeamAllowed(value);
    drafts.allowTeam(conversationId, value);
  };
  // Keyed by chat: switching chats ends a running dictation.
  const mic = <DictationButton key={conversationId} text={text} onText={change} />;
  const queueing = active || Boolean(queued);
  const canQueue = Boolean(queueing && (text.trim() || ready) && !attachments.blocked);
  const later = canQueue && (
    <button key="later" className="assistant-later">
      <Icon name="history" size={14} />
      {copy.queued.send}
    </button>
  );
  // Keyed apart, so focus on Send never carries over to Stop.
  const submit =
    queueing && !active ? null : active ? (
      <button
        key="stop"
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
        key="send"
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
      className={`assistant-composer${member ? " member" : ""}`}
      onSubmit={submitWithFiles}
    >
      <ChatScrollToBottom active output={output} stick={stick} scroll={scroll} />
      <ComposerOptions
        id={optionsId}
        open={optionsOpen}
        member={member || !team}
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
        <QueuedMessage
          queued={queued}
          name={assistant.name}
          active={active}
          available={available}
          field={field}
          onTakeBack={onTakeBack}
        />
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
          <>
            {mic}
            {later}
            {submit}
          </>
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
            {mic}
            {later}
            {submit}
          </div>
        )}
      </div>
    </form>
  );
}
