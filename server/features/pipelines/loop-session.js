import { createHash } from "node:crypto";

// A loop edge with `continueSession` sends its target back into the native session of
// the target's last attempt instead of a fresh kickoff. Every repair turn after a loop
// back records how it ran in `attempt.repair`: { edge, round, session: "resumed" |
// "fresh", fallback? }, where `fallback` names why a session that was asked for could
// not be continued.
export const RESUMED_REPAIR = "resumed-repair";

// What a native session is bound to: a different profile, account, connection, tool or
// model can never continue a conversation another one started.
export function sessionKey(profile) {
  const config = profile?.config || {};
  return createHash("sha256")
    .update(
      JSON.stringify([
        profile?.id ?? null,
        config.cliTool ?? null,
        config.accountId ?? null,
        profile?.accountSnapshot?.id ?? null,
        config.providerConnectionId ?? null,
        config.models?.default ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

// Native CLIs word an exhausted conversation differently; any of these means the
// session cannot take another turn.
const EXHAUSTED = [
  /context[ _-]?(window|length|limit|size)/i,
  /context[ _-]?overflow/i,
  /prompt is too long/i,
  /input is too long/i,
  /maximum context/i,
  /ran out of room/i,
];
export function contextExhausted(outcome) {
  const code = outcome?.errorCode;
  if (code === "context_length_exceeded") return true;
  const text = typeof outcome?.error === "string" ? outcome.error : "";
  return EXHAUSTED.some((pattern) => pattern.test(text));
}

// The turn a loop back starts for its target, decided before the loop resets the
// target's session: a resumed repair when the edge asks for it and the target's last
// session can take it, otherwise a fresh kickoff that records why.
export function repairLaunch(run, target, edge, { edgeKey, iteration }) {
  const repair = { edge: edgeKey, round: iteration };
  const fresh = (fallback) => ({
    kind: "kickoff",
    repair: { ...repair, session: "fresh", ...(fallback ? { fallback } : {}) },
  });
  if (!edge.continueSession) return fresh();
  if (!target.nativeId || !target.attemptId) return fresh("no-session");
  const turns = (run.executionLog || []).filter(
    (a) => a.nodeId === target.id && a.attemptId === target.attemptId,
  );
  if (turns.some((a) => a.contextExhausted)) return fresh("context-exhausted");
  if (
    turns.findLast((a) => a.sessionKey)?.sessionKey !== sessionKey(target.profileSnapshot)
  )
    return fresh("profile-changed");
  return {
    kind: RESUMED_REPAIR,
    resumeNativeId: target.nativeId,
    repair: { ...repair, session: "resumed" },
  };
}

// The fresh kickoff that replaces a resumed repair turn whose session failed.
export const freshAfterResume = (attempt, reason) => ({
  kind: "kickoff",
  repair: { ...attempt.repair, session: "fresh", fallback: reason },
});

// A parked repair turn that is retried or resumed after a usage reset starts over in a
// new session; it keeps the round it repairs, so the history and the round still
// count it as that round's repair.
export function relaunchOptions(run, node) {
  const opened = (run.executionLog || []).findLast(
    (a) => a.nodeId === node.id && a.attemptId === node.attemptId && a.repair,
  );
  if (!opened) return {};
  const { fallback, ...repair } = opened.repair;
  return {
    repair: {
      ...repair,
      session: "fresh",
      ...(repair.session === "resumed"
        ? { fallback: "retried" }
        : fallback
          ? { fallback }
          : {}),
    },
  };
}
