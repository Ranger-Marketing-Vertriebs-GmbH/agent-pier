import { commonCopy } from "../../lib/i18n/messages/common.js";
import { chatMessageCopy as copy } from "../../lib/i18n/messages/chat.js";
import React, { useState } from "react";
import ToolOutput from "./ToolOutput.jsx";
import Markdown, { defaultUrlTransform } from "react-markdown";
import { projectLinkPath } from "./chat-file-link.js";
import remarkGfm from "remark-gfm";
import ChatImages from "./ChatImages.jsx";
import { providerNames } from "./presentation.js";
export default function Message({ message, tool, sessionId, cwd, openFile }) {
  const [toolOpen, setToolOpen] = useState(false);
  if (message.role === "tool")
    return (
      <details
        className="chat-tool"
        onToggle={(event) => setToolOpen(event.currentTarget.open)}
      >
        <summary>
          <span aria-hidden="true">⌘</span>
          <strong>{message.toolName || copy.chatToolLabel}</strong>
          <small>
            {{
              running: commonCopy.running,
              completed: commonCopy.completed,
              failed: commonCopy.failed,
            }[message.status] || "Details"}
          </small>
        </summary>
        {toolOpen && <ToolOutput text={message.text} toolName={message.toolName} />}
      </details>
    );
  return (
    <article
      className={`chat-message ${message.role}`}
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
              const file = projectLinkPath(href, cwd);
              if (file === null)
                return (
                  <a {...props} href={href} target="_blank" rel="noreferrer noopener" />
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
