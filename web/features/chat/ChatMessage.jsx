import { commonCopy } from "../../lib/i18n/messages/common.js";
import { chatMessageCopy as copy } from "../../lib/i18n/messages/chat.js";
import React, { useState } from "react";
import ToolOutput from "./ToolOutput.jsx";
import TruncatedToolOutput from "./TruncatedToolOutput.jsx";
import ToolChanges from "./ToolChanges.jsx";
import Markdown, { defaultUrlTransform } from "react-markdown";
import { projectLinkPath } from "./chat-file-link.js";
import { artifactLink } from "../artifacts/artifact-return-link.js";
import remarkGfm from "remark-gfm";
import ChatImages from "./ChatImages.jsx";
import { providerNames } from "./presentation.js";
import { subagentRowStatus, subagentStatusLabel } from "./subagent-presentation.js";
export default function Message({
  message,
  tool,
  sessionId,
  cwd,
  openFile,
  subagentsLive = true,
  observedSubagents = [],
}) {
  const [toolOpen, setToolOpen] = useState(false);
  if (message.role === "tool") {
    const toolImages = (message.images || []).filter((image) => image?.source === "tool");
    const subagent = message.subagent;
    const status = subagent
      ? subagentRowStatus(message, observedSubagents, subagentsLive)
      : message.status;
    return (
      <details
        className={subagent ? "chat-tool chat-subagent" : "chat-tool"}
        data-message-id={message.id}
        data-status={subagent ? status : undefined}
        onToggle={(event) => setToolOpen(event.currentTarget.open)}
      >
        <summary>
          <span aria-hidden="true">{subagent ? "◇" : "⌘"}</span>
          <strong>
            {subagent
              ? copy.subagentLabel(subagent.description, subagent.type)
              : message.toolName || copy.chatToolLabel}
          </strong>
          <small>
            {subagent
              ? subagentStatusLabel(status)
              : {
                  running: commonCopy.running,
                  completed: commonCopy.completed,
                  failed: commonCopy.failed,
                }[status] || copy.toolDetails}
          </small>
        </summary>
        {toolOpen && toolImages.length > 0 && (
          <ChatImages images={toolImages} sessionId={sessionId} limit={Infinity} />
        )}
        {toolOpen &&
          (message.fileChanges?.length ? (
            <ToolChanges message={message} sessionId={sessionId} />
          ) : message.truncated ? (
            <TruncatedToolOutput
              key={`${message.id}:${message.truncated.length}`}
              message={message}
              sessionId={sessionId}
            />
          ) : (
            <ToolOutput text={message.text} toolName={message.toolName} />
          ))}
      </details>
    );
  }
  return (
    <article
      className={`chat-message ${message.role}`}
      data-message-id={message.id}
      aria-label={
        message.role === "user"
          ? copy.ariaLabel
          : commonCopy.providerMessageLabel(providerNames[tool])
      }
    >
      {message.role !== "user" && (
        <div className="message-byline">{providerNames[tool]}</div>
      )}
      <div className="message-content">
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
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
            img: ({ alt }) => (
              <span className="subtle">
                {copy.subtle}
                {alt ? `: ${alt}` : ""}]
              </span>
            ),
          }}
        >
          {message.text}
        </Markdown>
      </div>
      <ChatImages images={message.images} sessionId={sessionId} />
    </article>
  );
}
