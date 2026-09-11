import React from "react";
import Message from "./ChatMessage.jsx";
import { chatMessageCopy as copy } from "../../lib/i18n/messages/chat.js";
import "./tool-groups.css";

export function groupMessages(messages) {
  const groups = [];
  let anchor = "start";
  for (const message of messages) {
    if (message.role !== "tool") {
      groups.push({ key: `message:${message.id}`, message });
      anchor = message.id;
    } else {
      let group = groups.at(-1);
      if (!group?.tools) {
        group = { key: `tools:${anchor}`, tools: [] };
        groups.push(group);
      }
      group.tools.push(message);
    }
  }
  return groups;
}

export default function ChatTranscript({ messages, live, ...props }) {
  const groups = groupMessages(messages);
  return groups.map((group, index) => {
    if (group.message)
      return <Message key={group.key} message={group.message} {...props} />;
    const running =
      live &&
      index === groups.length - 1 &&
      group.tools.some((message) => message.status === "running");
    const failures = group.tools.filter((message) => message.status === "failed").length;
    return (
      <details className="chat-tool-group" key={group.key}>
        <summary>
          <span className="tool-group-chevron" aria-hidden="true">
            ›
          </span>
          {running && <span className="tool-group-spinner" aria-hidden="true" />}
          <span className="tool-group-title">
            {running ? copy.agentWorking : copy.agentActivity}
          </span>
          <span className="tool-group-count">{copy.toolCount(group.tools.length)}</span>
          {failures > 0 && (
            <span className="tool-group-failures">{copy.toolFailures(failures)}</span>
          )}
        </summary>
        <div className="tool-group-content">
          {group.tools.map((message) => (
            <Message key={message.id} message={message} {...props} />
          ))}
        </div>
      </details>
    );
  });
}
