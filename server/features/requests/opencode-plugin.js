import { randomUUID } from "node:crypto";
import { NativeRequestChannel } from "./native-channel.js";
import { questionsView, questionAnswers } from "./native-questions.js";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
export const id = "agentpier-requests";
export function observeOpenCode(api, channel) {
  const seen = new Map();
  const current = () =>
    api.route.current?.name === "session" ? api.route.current.params?.sessionID : null;
  function update() {
    const sessionId = current();
    const live = new Set();
    for (const kind of ["permission", "question"]) {
      const requests = sessionId ? api.state.session[kind](sessionId) || [] : [];
      for (const request of requests) {
        if (request.sessionID !== sessionId) continue;
        const identity = JSON.stringify([sessionId, kind, request.id]);
        live.add(identity);
        if (seen.has(identity)) continue;
        const key = randomUUID();
        seen.set(identity, key);
        const view =
          kind === "question"
            ? { kind, questions: questionsView(request.questions, "opencode") }
            : {
                kind,
                subject: {
                  tool: request.permission,
                  command: request.metadata?.command,
                  description: [
                    request.patterns?.join("\n"),
                    JSON.stringify(request.metadata || {}, null, 2),
                    ...(request.always?.length
                      ? [copy.sessionRules, request.always.join("\n")]
                      : []),
                  ]
                    .filter(Boolean)
                    .join("\n"),
                },
                options: [
                  { id: "once", label: copy.once, scope: "once" },
                  ...(request.always?.length
                    ? [{ id: "always", label: copy.sessionAllow, scope: "session" }]
                    : []),
                  { id: "reject", label: copy.deny },
                ],
              };
        channel.publish(key, view, async (answer) => {
          // Recheck the TUI's live session and pending set directly before the native HTTP call.
          if (
            current() !== sessionId ||
            !(api.state.session[kind](sessionId) || []).some(
              (value) => value.id === request.id && value.sessionID === sessionId,
            )
          )
            throw Object.assign(Error("Native request resolved"), { stale: true });
          if (answer.handoff) return;
          const value =
            kind === "question"
              ? {
                  requestID: request.id,
                  answers: questionAnswers(request.questions, answer.answers),
                }
              : { requestID: request.id, reply: answer.choice };
          const result = await api.client[kind].reply(value, { throwOnError: true });
          if (result?.error) throw Error("Native request delivery failed");
        });
      }
    }
    for (const [identity, key] of seen)
      if (!live.has(identity)) {
        seen.delete(identity);
        channel.resolve(key);
      }
  }
  return {
    update,
    close: () => {
      for (const key of seen.values()) channel.resolve(key);
      seen.clear();
      channel.close();
    },
  };
}
export async function tui(api) {
  if (
    !api.state?.session?.permission ||
    !api.state?.session?.question ||
    !api.client?.permission?.reply ||
    !api.client?.question?.reply
  )
    return;
  const observer = observeOpenCode(api, new NativeRequestChannel());
  const update = () => {
    try {
      observer.update();
    } catch {
      /* Native TUI keeps ownership when plugin data is unavailable. */
    }
  };
  update();
  const timer = setInterval(update, 250);
  timer.unref?.();
  api.lifecycle.onDispose(() => {
    clearInterval(timer);
    observer.close();
  });
}
export default { id, tui };
