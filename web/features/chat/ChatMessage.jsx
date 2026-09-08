import { commonCopy } from "../../lib/i18n/messages/common.js";
import { chatMessageCopy as copy } from "../../lib/i18n/messages/chat.js";
import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ChatImages from "./ChatImages.jsx";
import { providerNames } from "./presentation.js";
export default function Message({ message, tool, sessionId }) {
  if (message.role === "tool")
    return (
      <details className="chat-tool">
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
        <pre>{message.text}</pre>
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
          components={{
            a: ({ node: _node, ...props }) => (
              <a {...props} target="_blank" rel="noreferrer noopener" />
            ),
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
