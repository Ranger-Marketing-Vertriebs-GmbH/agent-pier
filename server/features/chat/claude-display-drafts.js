import { maxReplyText } from "../requests/native-push.js";

// Claude Code's MessageDisplay hook as live reply text. The hook fires once per batch
// of newly completed lines of an assistant message (`index` counts the batches,
// exactly one has `final`), and AgentPier runs it asynchronously, so batches can
// arrive out of order: they are put back in `index` order before they are shown.
// Its `message_id` is not the transcript's message id, so a draft is labelled with
// its turn and its order among the turn's text messages; the browser replaces it
// when the transcript's turn holds that many replies (web/features/chat/reply-stream.js).
const maxMessages = 32;
// Batches further ahead than this wait for nothing: they are dropped.
const maxAhead = 256;
const runId = (messageId) => `claude-${messageId}`;

export class ClaudeDisplayDrafts {
  /** `streams` is ChatStreams (streamText/endStream). */
  constructor({ streams, maxTurnText = maxReplyText }) {
    this.streams = streams;
    this.maxTurnText = maxTurnText;
    this.turns = new Map();
  }
  /** One MessageDisplay batch: {turnId, messageId, index, final, delta}. */
  display(sessionId, { turnId, messageId, index, final, delta }) {
    let turn = this.turns.get(sessionId);
    if (turn && turn.id !== turnId) {
      // A new turn: whatever the last one left (an interrupt) is over.
      this.end(sessionId);
      turn = null;
    }
    if (!turn) {
      turn = { id: turnId, messages: new Map(), size: 0 };
      this.turns.set(sessionId, turn);
    }
    let message = turn.messages.get(messageId);
    if (!message) {
      if (turn.messages.size >= maxMessages) return;
      message = { order: turn.messages.size, next: 0, chunks: new Map(), text: "" };
      turn.messages.set(messageId, message);
    }
    if (
      index < message.next ||
      message.chunks.has(index) ||
      index > message.next + maxAhead
    )
      return;
    message.chunks.set(index, delta);
    if (final) message.final = index;
    let grew = false;
    while (message.chunks.has(message.next)) {
      const part = message.chunks.get(message.next);
      message.chunks.delete(message.next++);
      // The cap holds the turn's first part; the transcript brings the rest.
      const room = Math.max(0, this.maxTurnText - turn.size);
      const taken = part.slice(0, room);
      message.text += taken;
      turn.size += taken.length;
      grew ||= taken.length > 0;
    }
    if (grew)
      this.streams.streamText(sessionId, runId(messageId), {
        text: message.text,
        turn: turn.id,
        order: message.order,
      });
  }
  /**
   * Stop: the turn's last text message is `lastAssistantMessage` (the hook payload's
   * whole reply), then the turn's drafts end and the chat reads its transcript.
   */
  stop(sessionId, lastAssistantMessage) {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    const last = [...turn.messages].at(-1);
    if (last && typeof lastAssistantMessage === "string" && lastAssistantMessage.trim())
      this.streams.streamText(sessionId, runId(last[0]), {
        text: lastAssistantMessage.slice(0, this.maxTurnText),
        turn: turn.id,
        order: last[1].order,
      });
    this.end(sessionId);
  }
  /** The turn ended without a reply to keep (interrupt, failure, session end). */
  end(sessionId) {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    this.turns.delete(sessionId);
    this.streams.endStream(sessionId, undefined, { turn: turn.id });
  }
}
