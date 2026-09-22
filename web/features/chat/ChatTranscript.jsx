import NativeDeliveryBadge from "./NativeDeliveryBadge.jsx";
import React, { useRef } from "react";
import Message from "./ChatMessage.jsx";
import { chatMessageCopy as copy } from "../../lib/i18n/messages/chat.js";
import "./tool-groups.css";

/**
 * Tool groups keep their key while rows are prepended or appended: a group
 * reuses the key already held by one of its tools (older pages can merge tool
 * rows into the leading group), and a new group is keyed by its first tool.
 */
export function groupMessages(messages, known = new Map()) {
  const groups = [];
  for (const message of messages) {
    if (message.role !== "tool") {
      groups.push({ key: `message:${message.id}`, message });
    } else {
      let group = groups.at(-1);
      if (!group?.tools) {
        group = { tools: [] };
        groups.push(group);
      }
      group.tools.push(message);
    }
  }
  const used = new Set();
  const keys = new Map();
  for (const group of groups) {
    if (!group.tools) continue;
    const candidates = [
      ...group.tools.map((tool) => known.get(tool.id)).filter(Boolean),
      `tools:${group.tools[0].id}`,
    ];
    group.key =
      candidates.find((key) => !used.has(key)) ||
      `tools:${group.tools[0].id}:${groups.indexOf(group)}`;
    used.add(group.key);
    for (const tool of group.tools) keys.set(tool.id, group.key);
  }
  return { groups, keys };
}

export default function ChatTranscript({ messages, live, nativeStates, ...props }) {
  const known = useRef(new Map());
  const { groups, keys } = groupMessages(messages, known.current);
  known.current = keys;
  return groups.map((group, index) => {
    if (group.message) {
      const native = [...(nativeStates?.values() || [])].find(
        (value) => value.messageId === group.message.id,
      );
      return (
        <React.Fragment key={group.key}>
          <Message message={group.message} {...props} />
          {native && <NativeDeliveryBadge state={native.state} tool={props.tool} />}
        </React.Fragment>
      );
    }
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
