import Message from "./ChatMessage.jsx";
import { visibleReplies } from "./reply-stream.js";
import "./live-replies.css";

/**
 * The reply the CLI is generating now, as live assistant bubbles below the
 * transcript; each gives way to its message once the transcript sync holds it.
 */
export default function ChatLiveReplies({ replies, data, session, restored, openFile }) {
  if (restored || session.status !== "running") return null;
  return visibleReplies(replies, data).map((run) => (
    <Message
      key={`stream:${run.runId}`}
      message={{ id: `stream:${run.runId}`, role: "assistant", text: run.text }}
      streaming
      tool={session.tool}
      sessionId={session.id}
      cwd={session.cwd}
      openFile={openFile}
    />
  ));
}
