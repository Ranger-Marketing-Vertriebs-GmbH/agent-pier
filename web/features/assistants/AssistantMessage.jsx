import React, { memo } from "react";
import ChatMarkdown from "../../components/ChatMarkdown.jsx";

// Memoized so a streamed delta re-parses only the streaming message, not the history.
// The owner's own name stays for screen readers only; the bubble already says who.
export default memo(function AssistantMessage({ role, name, text, streaming = false }) {
  return (
    <article className={`assistant-message ${role}${streaming ? " streaming" : ""}`}>
      <strong className={role === "user" ? "sr-only" : undefined}>{name}</strong>
      <div className="message-content">
        <ChatMarkdown>{text}</ChatMarkdown>
      </div>
    </article>
  );
});
