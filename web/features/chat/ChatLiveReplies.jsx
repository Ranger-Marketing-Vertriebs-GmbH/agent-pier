import Message from "./ChatMessage.jsx";
import { visibleReplies } from "./reply-stream.js";
import { liveToolName } from "./live-status.js";
import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import "./live-replies.css";

/**
 * The reply the CLI is generating now, as live assistant bubbles below the
 * transcript; each gives way to its message once the transcript sync holds it. An
 * ended run waits for the transcript without claiming to be written. While the
 * model writes a tool call, one line names the tool.
 */
export default function ChatLiveReplies({
  replies,
  data,
  session,
  restored,
  openFile,
  liveStatus,
}) {
  if (restored || session.status !== "running") return null;
  const preparing = liveStatus?.state === "working" ? liveStatus.preparing : "";
  return (
    <>
      {visibleReplies(replies, data).map((run) => (
        <Message
          key={`stream:${run.runId}`}
          message={{ id: `stream:${run.runId}`, role: "assistant", text: run.text }}
          streaming={!run.ended}
          tool={session.tool}
          sessionId={session.id}
          cwd={session.cwd}
          openFile={openFile}
        />
      ))}
      {preparing && (
        <p className="chat-live-preparing" role="status">
          <span className="chat-working-spinner" aria-hidden="true" />
          {copy.livePreparingLine(liveToolName(preparing))}
        </p>
      )}
    </>
  );
}
