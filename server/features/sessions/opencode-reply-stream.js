// OpenCode's streaming message-part events as reply text for the session chat: each
// assistant text part of the visible session is one run (its id is also the row id
// of the finished part in the history), labelled with its message as the turn.
// A tool part that is still `pending` is a tool call whose input the model is
// writing: its name (never its input) goes out as `preparing` until the call runs,
// text follows or the message or session ends.
// `channel` is a NativeRequestChannel (streamText/streamEnd/preparing); `visible()`
// names the session the TUI shows. Returns the function that unsubscribes.
import { maxReplyText } from "../requests/native-push.js";

const maxTracked = 256;

export function streamOpenCodeReplies(api, channel, visible) {
  if (typeof api?.event?.on !== "function") return () => {};
  const roles = new Map();
  const parts = new Map();
  const remember = (map, key, value) => {
    map.set(key, value);
    if (map.size > maxTracked) map.delete(map.keys().next().value);
  };
  const role = (sessionID, messageID) =>
    roles.get(messageID) ??
    api.state?.session?.messages?.(sessionID)?.find((m) => m.id === messageID)?.role;
  const textPart = (messageID, partID) =>
    api.state?.part?.(messageID)?.find((part) => part.id === partID)?.type === "text";
  // The pending tool parts by id, oldest first; the newest one still pending shows.
  const pending = new Map();
  const report = () => channel.preparing?.([...pending.values()].at(-1)?.tool ?? null);
  const prepare = (part) => {
    pending.delete(part.id);
    remember(pending, part.id, { tool: part.tool, session: part.sessionID });
    report();
  };
  // A part that left `pending`, or every part (of `session`, when given).
  const prepared = (session, id) => {
    for (const [key, part] of [...pending])
      if (id ? key === id : !session || part.session === session) pending.delete(key);
    report();
  };
  const end = (match = () => true) => {
    for (const [id, part] of [...parts])
      if (match(part)) {
        parts.delete(id);
        channel.streamEnd(id);
      }
  };
  const guard = (handler) => (event) => {
    try {
      handler(event?.properties || {});
    } catch {
      /* Streaming is advisory; the transcript still brings the reply. */
    }
  };
  const offs = [
    api.event.on(
      "message.updated",
      guard(({ info }) => {
        if (typeof info?.id !== "string") return;
        remember(roles, info.id, info.role);
        if (info.role === "assistant" && info.time?.completed) {
          end((part) => part.messageID === info.id);
          prepared(info.sessionID);
        }
      }),
    ),
    api.event.on(
      "message.part.updated",
      guard(({ part }) => {
        if (part?.type === "tool") {
          // A part leaves `pending` in any session: one the TUI no longer shows too.
          if (part.state?.status !== "pending") prepared(undefined, part.id);
          else if (part.sessionID === visible() && typeof part.tool === "string")
            prepare(part);
          return;
        }
        if (
          part?.type !== "text" ||
          part.synthetic ||
          part.ignored ||
          typeof part.id !== "string" ||
          part.sessionID !== visible() ||
          role(part.sessionID, part.messageID) !== "assistant"
        )
          return;
        if (!part.time?.end) prepared();
        const held = { messageID: part.messageID, text: String(part.text || "") };
        remember(parts, part.id, held);
        channel.streamText(part.id, held.text, { turn: part.messageID });
        if (part.time?.end) end((value) => value === held);
      }),
    ),
    api.event.on(
      "message.part.delta",
      guard(({ sessionID, messageID, partID, field, delta }) => {
        if (field !== "text" || typeof delta !== "string" || sessionID !== visible())
          return;
        let held = parts.get(partID);
        if (!held) {
          // Reasoning parts stream a `text` field too: only assistant text counts.
          if (role(sessionID, messageID) !== "assistant" || !textPart(messageID, partID))
            return;
          held = { messageID, text: "" };
          remember(parts, partID, held);
        }
        prepared();
        if (held.text.length >= maxReplyText) return;
        held.text += delta;
        channel.streamText(partID, held.text, { turn: messageID });
      }),
    ),
    api.event.on(
      "session.idle",
      guard(({ sessionID }) => {
        if (sessionID === visible()) end();
        prepared(sessionID);
      }),
    ),
  ];
  return () => {
    for (const off of offs) if (typeof off === "function") off();
    end();
    prepared();
  };
}
