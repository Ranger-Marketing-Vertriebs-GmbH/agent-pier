import React, { memo } from "react";
import ChatMarkdown from "../../components/ChatMarkdown.jsx";

// Memoized so a streamed delta re-parses only the streaming message, not the history.
export default memo(function AssistantMessage({ role, name, text }) {
  return (
    <article className={`assistant-message ${role}`}>
      <strong>{name}</strong>
      <div className="message-content">
        <ChatMarkdown>{text}</ChatMarkdown>
      </div>
    </article>
  );
});
