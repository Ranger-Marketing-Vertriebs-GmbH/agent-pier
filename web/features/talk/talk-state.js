// Talk mode's pure rules (useTalk.js): what follows a turn, and how a phase shows.

/**
 * What talk mode does while it waits for the agent: `baseline` is the newest reply id
 * and attempt id from before the spoken turn, `turn` the chat now. "speak" names the
 * new reply; "listen" follows a turn that ended without one; "wait" otherwise.
 */
export function afterTurn(baseline, turn) {
  if (turn.active) return { next: "wait" };
  if (turn.replyId && turn.replyId !== baseline.replyId)
    return { next: "speak", messageId: turn.replyId };
  if (
    turn.attemptId &&
    turn.attemptId !== baseline.attemptId &&
    ["completed", "failed", "cancelled"].includes(turn.attemptState)
  )
    return { next: "listen", notice: "noReply" };
  return { next: "wait" };
}

const tones = {
  starting: "pending",
  listening: "ok",
  thinking: "waiting",
  speaking: "working",
  paused: "idle",
};
/** The StatusDot tone of a talk phase, and whether it pulses. */
export const phaseTone = (phase) => ({
  tone: tones[phase] || "idle",
  pulse: ["listening", "thinking", "speaking"].includes(phase),
});

/**
 * The words heard so far in one spoken turn: finals add up, an interim result
 * replaces the previous interim one. Returns the next `{ finals, interim }`.
 */
export function heardWords(heard, message) {
  if (!message.final) return { ...heard, interim: message.text };
  return {
    finals: message.text ? [...heard.finals, message.text] : heard.finals,
    interim: "",
  };
}
export const heardText = ({ finals, interim }) =>
  [...finals, interim].filter(Boolean).join(" ");

/** The text of a talk notice: `{ source, code, minutes }`, with the dictation copy. */
export function talkNotice(notice, copy, dictation) {
  if (!notice) return "";
  if (notice.source === "ended")
    return notice.code === "limit"
      ? copy.ended.limit(notice.minutes || 30)
      : copy.ended[notice.code] || copy.ended.stopped;
  if (notice.source === "speak") return copy.speak[notice.code] || copy.speak.failed;
  if (notice.source === "reason")
    return copy.reasons[notice.code] || copy.reasons.unknown;
  return (
    copy.errors[notice.code] ||
    copy.reasons[notice.code] ||
    dictation.errors[notice.code] ||
    copy.errors.failed
  );
}
