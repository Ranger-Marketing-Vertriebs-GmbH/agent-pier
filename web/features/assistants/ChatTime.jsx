import React from "react";
import { formatChatTime, formatChatTimeTitle } from "../../lib/i18n/index.js";
import "./assistant-message-source.css";

// A message's or notice's time as a quiet <time>; nothing without a timestamp.
export default function ChatTime({ timestamp }) {
  if (!(timestamp > 0)) return null;
  return (
    <time
      className="assistant-message-time"
      dateTime={new Date(timestamp).toISOString()}
      title={formatChatTimeTitle(timestamp)}
    >
      {formatChatTime(timestamp)}
    </time>
  );
}
