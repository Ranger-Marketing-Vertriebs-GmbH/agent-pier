import { commonCopy } from "../../lib/i18n/messages/common.js";
import { chatMessageCopy as copy } from "../../lib/i18n/messages/chat.js";
import React, { useState } from "react";
import ToolOutput from "./ToolOutput.jsx";
import TruncatedToolOutput from "./TruncatedToolOutput.jsx";
import ToolChanges from "./ToolChanges.jsx";
import { formatSize } from "./tool-output.js";
import { sandboxDenied } from "./sandbox-denial.js";
import { defaultUrlTransform } from "react-markdown";
import ChatMarkdown from "../../components/ChatMarkdown.jsx";
import { projectLinkPath } from "./chat-file-link.js";
import { artifactLink } from "../artifacts/artifact-return-link.js";
import ChatImages from "./ChatImages.jsx";
import Icon from "../../components/Icon.jsx";
import { chatAttachmentsCopy } from "../../lib/i18n/messages/chat.js";
import { userAttachments } from "./user-attachments.js";
import { providerNames, toolDisplayName } from "./presentation.js";
import { subagentRowStatus, subagentStatusLabel } from "./subagent-presentation.js";
import { observedAgent, usageSummary } from "./token-presentation.js";
import { connectionsRoutePath } from "../connections/routes.js";
export default function Message({
  message,
  tool,
  sessionId,
  cwd,
  openFile,
  subagentsLive = true,
  observedSubagents = [],
  sandboxProfile = "",
  // False where the rows are not this session's own (a subagent transcript): a
  // truncated row then cannot load its full text from the session.
  fullOutput = true,
  // A reply the CLI is still generating (ChatLiveReplies.jsx).
  streaming = false,
}) {
  // Bash-mode output answers the user's own command, so it starts expanded.
  const [toolOpen, setToolOpen] = useState(Boolean(message.shellOutput));
  if (message.role === "tool") {
    const toolImages = (message.images || []).filter((image) => image?.source === "tool");
    const subagent = message.subagent;
    const status = subagent
      ? subagentRowStatus(message, observedSubagents, subagentsLive)
      : message.status;
    const blocked = sandboxDenied(message, sandboxProfile);
    const usage = subagent
      ? usageSummary(observedAgent(message, observedSubagents)?.usage)
      : null;
    return (
      <details
        className={subagent ? "chat-tool chat-subagent" : "chat-tool"}
        data-message-id={message.id}
        data-status={subagent ? status : undefined}
        open={toolOpen}
        onToggle={(event) => setToolOpen(event.currentTarget.open)}
      >
        <summary>
          <span aria-hidden="true">{subagent ? "◇" : "⌘"}</span>
          <strong>
            {subagent
              ? copy.subagentLabel(subagent.description, subagent.type)
              : message.shellOutput
                ? copy.shellOutputLabel
                : toolDisplayName(message.toolName)}
          </strong>
          <small className={blocked ? "chat-tool-sandbox" : undefined}>
            {subagent
              ? subagentStatusLabel(status)
              : blocked
                ? copy.sandboxBlocked
                : {
                    running: commonCopy.running,
                    completed: commonCopy.completed,
                    failed: commonCopy.failed,
                  }[status] || copy.toolDetails}
          </small>
          {usage && <small className="subagent-usage">{usage}</small>}
        </summary>
        {toolOpen && blocked && (
          <p className="chat-tool-sandbox-hint">
            {copy.sandboxBlockedHint(sandboxProfile)}
          </p>
        )}
        {toolOpen && toolImages.length > 0 && (
          <ChatImages images={toolImages} sessionId={sessionId} limit={Infinity} />
        )}
        {toolOpen &&
          (message.fileChanges?.length ? (
            <ToolChanges
              message={message}
              sessionId={sessionId}
              fullOutput={fullOutput}
            />
          ) : message.truncated ? (
            <TruncatedToolOutput
              key={`${message.id}:${message.truncated.length}`}
              message={message}
              sessionId={sessionId}
              loadable={fullOutput}
            />
          ) : (
            <>
              {message.shellOmitted && (
                <p className="tool-output-omitted">
                  {copy.shellOutputOmitted(
                    formatSize(
                      Object.values(message.shellOmitted).reduce((a, b) => a + b, 0),
                    ),
                  )}
                </p>
              )}
              <ToolOutput
                text={message.text}
                toolName={message.toolName}
                shell={Boolean(message.shellOutput)}
              />
            </>
          ))}
      </details>
    );
  }
  // A provider refused the reply (an OpenCode message error): say so where the
  // reply would be, with the way to the model connections.
  if (message.notice === "provider-error")
    return (
      <div className="chat-limit-warnings" role="alert" data-message-id={message.id}>
        <p>{copy.providerError}</p>
        <p>{message.text}</p>
        <div className="chat-limit-actions">
          <a href={connectionsRoutePath({ section: "models" })}>
            {copy.openModelConnections}
          </a>
        </div>
      </div>
    );
  if (message.notice === "usage-limit")
    return (
      <div className="chat-limit-warnings" role="status" data-message-id={message.id}>
        <p>{message.text}</p>
      </div>
    );
  // A user row shows the composer's attachment path lines as chips (user-attachments.js).
  const shown =
    message.role === "user"
      ? userAttachments(message.text, message.images)
      : { text: message.text, files: [] };
  return (
    <article
      className={`chat-message ${message.role}${streaming ? " streaming" : ""}`}
      data-message-id={message.id}
      data-streaming={streaming || undefined}
      aria-busy={streaming || undefined}
      aria-label={
        message.role === "user"
          ? copy.ariaLabel
          : commonCopy.providerMessageLabel(providerNames[tool])
      }
    >
      {message.role !== "user" && (
        <div className="message-byline">
          {providerNames[tool]}
          {streaming && (
            <span className="message-streaming"> · {copy.replyStreaming}</span>
          )}
        </div>
      )}
      <div className="message-content">
        <ChatMarkdown
          urlTransform={(url) =>
            projectLinkPath(url, cwd) === null ? defaultUrlTransform(url) : url
          }
          components={{
            a: ({ node: _node, href, ...props }) => {
              const artifact = artifactLink(
                href,
                `/sessions/${encodeURIComponent(sessionId)}/chat`,
              );
              const file = projectLinkPath(href, cwd);
              if (artifact || file === null)
                return (
                  <a
                    {...props}
                    href={artifact || href}
                    target="_blank"
                    rel="noreferrer noopener"
                  />
                );
              const target = `/sessions/${encodeURIComponent(sessionId)}/files?${new URLSearchParams({ file })}`;
              return (
                <a
                  {...props}
                  href={target}
                  onClick={(event) => {
                    if (
                      !openFile ||
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    openFile(file);
                  }}
                />
              );
            },
          }}
        >
          {shown.text}
        </ChatMarkdown>
      </div>
      {shown.files.length > 0 && (
        <ul
          className="chat-attachment-list chat-message-attachments"
          aria-label={chatAttachmentsCopy.listAriaLabel}
        >
          {shown.files.map((file, index) => (
            <li key={`${file.path}-${index}`} className="chat-attachment-chip">
              <Icon name="file" size={16} />
              <span className="chat-attachment-name" title={file.path}>
                {file.name}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ChatImages
        images={message.images}
        sessionId={sessionId}
        fileName={message.role === "user"}
      />
    </article>
  );
}
