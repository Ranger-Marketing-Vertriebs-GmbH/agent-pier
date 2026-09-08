import useFileDrop from "../../components/useFileDrop.js";
import ChatDeliveryStatus from "./ChatDeliveryStatus.jsx";
import RequestPanel from "../requests/RequestPanel.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  chatViewCopy as copy,
  chatAttachmentsCopy as attachmentsCopy,
} from "../../lib/i18n/messages/chat.js";
import { providerNames } from "./presentation.js";
import React, { useState } from "react";
import ModelControl from "../models/ModelControl.jsx";
import Tasks from "./TaskPanel.jsx";
import Message from "./ChatMessage.jsx";
import ConversationPicker from "./ConversationPicker.jsx";
import ChatComposer from "./ChatComposer.jsx";
import ChatObservability from "./ChatObservability.jsx";
import useChatController from "./useChatController.js";
export default function ChatView({
  active,
  session,
  request,
  onConnection,
  openTerminal,
}) {
  const {
    data,
    delivery,
    tasksOpen,
    closeTasks,
    taskId,
    compactTasks,
    taskTrigger,
    openTasks,
    toggleTasks,
    setPicking,
    output,
    outputHeight,
    scroll,
    stick,
    picking,
    choose,
    loadError,
    error,
    setModelPending,
    submit,
    text,
    setText,
    setSent,
    touchInput,
    sent,
    busy,
    modelPending,
    attachments,
  } = useChatController({
    active,
    session,
    request,
    onConnection,
    openTerminal,
  });
  const requestsAvailable = Boolean(
    session.nativeRequests?.enabled &&
    session.purpose !== "login" &&
    session.tool !== "shell" &&
    !session.pipeline?.headless,
  );
  const [requestState, setRequestState] = useState(null);
  const requestPending =
    requestsAvailable && (requestState?.sessionId !== session.id || requestState.blocked);
  const drop = useFileDrop({
    enabled:
      active &&
      attachments.supported &&
      !attachments.loading &&
      !requestPending &&
      !busy &&
      !modelPending &&
      !attachments.uploading &&
      !delivery.locked,
    onFiles: attachments.add,
  });
  const guardedSubmit = (event) => {
    if (requestPending) {
      event.preventDefault();
      return;
    }
    submit(event);
  };
  return (
    <div className="chat-layout">
      <Tasks
        tasks={data?.tasks || []}
        subagents={data?.observability?.subagents || []}
        open={tasksOpen}
        close={closeTasks}
        id={taskId}
        compact={compactTasks}
        active={active}
      />
      <section
        className="chat-main"
        aria-label={copy.chatMainAriaLabel}
        {...drop}
        data-drop-hint={attachmentsCopy.dropHint}
      >
        <div className="chat-context">
          <button
            ref={taskTrigger}
            type="button"
            className="tasks-toggle"
            aria-label={tasksOpen ? copy.hideTasks : copy.showTasks}
            aria-expanded={tasksOpen}
            aria-controls={taskId}
            onClick={toggleTasks}
          >
            {copy.tasksToggle}{" "}
            <span>
              {(data?.tasks || []).filter((task) => task.status === "completed").length}/
              {data?.tasks?.length || 0}
            </span>
          </button>
          <div>
            {data?.providerSessionId && (
              <button onClick={() => setPicking((value) => !value)}>
                {copy.changeConversation}
              </button>
            )}
            <button onClick={openTerminal}>
              {requestsAvailable ? copy.terminalFallback : copy.terminalApprovals}
            </button>
          </div>
        </div>
        <ChatObservability
          session={session}
          observability={data?.observability}
          showSubagents={openTasks}
        />
        <div
          className="chat-messages"
          ref={output}
          aria-label={commonCopy.chatHistory}
          onScroll={(event) => {
            if (!active) return;
            // Resizing can emit scroll before ResizeObserver runs. It must not
            // turn off bottom-following as though the user scrolled backwards.
            if (event.currentTarget.clientHeight !== outputHeight.current) return;
            scroll.current = event.currentTarget.scrollTop;
            stick.current =
              event.currentTarget.scrollHeight -
                event.currentTarget.scrollTop -
                event.currentTarget.clientHeight <
              80;
          }}
        >
          {(data?.availability === "unbound" || picking) && (
            <ConversationPicker
              session={session}
              request={request}
              selected={data?.providerSessionId}
              choose={choose}
              cancel={picking ? () => setPicking(false) : undefined}
            />
          )}
          {data?.notice && <p className="chat-notice">{data.notice}</p>}
          {data?.messages?.map((message) => (
            <Message
              key={message.id}
              message={message}
              tool={session.tool}
              sessionId={session.id}
            />
          ))}
          <ChatDeliveryStatus
            delivery={delivery}
            messages={data?.messages || []}
            session={session}
            blocked={
              requestPending ||
              modelPending ||
              session.status !== "running" ||
              session.pipeline?.headless
            }
          />
          {data &&
            !delivery.outbox &&
            !delivery.recent.length &&
            !data.messages.length &&
            data.availability !== "unbound" && (
              <div className="chat-empty">
                <span aria-hidden="true">✳</span>
                <h2>{copy.chatEmptyHeading}</h2>
                <p>
                  {copy.emptyConversationPrefix} {providerNames[session.tool]}
                  {copy.emptyConversationSuffix}
                </p>
              </div>
            )}
          {!data && !loadError && <p className="chat-notice">{copy.chatNotice}</p>}
        </div>
        {loadError && <ErrorMessage error={loadError} />}
        {error && <ErrorMessage error={error} />}
        <div
          className="chat-compose-area"
          data-native-request-pending={requestPending || undefined}
        >
          {requestsAvailable && (
            <RequestPanel
              onStateChange={setRequestState}
              session={session}
              active={active}
              openTerminal={openTerminal}
            />
          )}
          <div className="chat-composer-shell">
            <ModelControl
              blocked={requestPending || delivery.locked}
              session={session}
              active={active}
              request={request}
              openTerminal={openTerminal}
              onPendingChange={setModelPending}
            />
            <ChatComposer
              {...{
                submit: guardedSubmit,
                requestPending,
                deliveryLocked: delivery.locked,
                session,
                text,
                setText,
                setSent,
                touchInput,
                sent,
                busy,
                modelPending,
                attachments,
              }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
