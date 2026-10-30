import { randomUUID } from "node:crypto";
import { send } from "./wire.js";

/**
 * Sends `answer` for occurrence `key` to its native owner and resolves with what the
 * owner reported: `answered`, `stale` or `unknown` (no word within ten seconds).
 */
export function deliver(broker, socket, key, answer) {
  return new Promise((resolve) => {
    const delivery = randomUUID();
    const finish = (value) => {
      clearTimeout(timer);
      broker.deliveries.delete(delivery);
      resolve(value);
    };
    const timer = setTimeout(() => finish("unknown"), 10000);
    broker.deliveries.set(delivery, { socket, finish });
    if (!send(socket, { type: "answer", delivery, key, answer })) finish("unknown");
  });
}

const denials = ["deny", "decline", "reject", "cancel"];

/**
 * The audited decision of an answer from chat. Approvals that last beyond this call
 * keep their own decision: `allow-session` and `allow-project` (remembered by
 * AgentPier, or the CLI's own session approval) and `allow-always` (Claude's rule).
 */
export function answerDecision(entry, input, answer, { handoff, remembered }) {
  if (handoff) return "handoff";
  if (entry.kind === "question") return answer.decline ? "deny" : "answer";
  if (remembered) return `allow-${remembered}`;
  if (denials.includes(input.choice)) return "deny";
  const scope = entry.options?.find((option) => option.id === input.choice)?.scope;
  if (scope === "persistent") return "allow-always";
  // A plan's choices set a mode for the session; they approve no tool.
  if (scope === "session" && !entry.subject?.plan) return "allow-session";
  return "allow";
}

/**
 * Answers a new request without a card when the default list or a remembered
 * approval covers it (request-approvals.js). True when nothing is left to show:
 * the CLI took the answer, or the request was already gone. Any other result
 * shows the card as usual.
 */
export async function autoAnswer(broker, entry, session) {
  let decided;
  try {
    decided = await broker.approvals.prepare(entry, session);
  } catch {
    return false;
  }
  if (!decided) return false;
  const status = await deliver(broker, entry.socket, entry.key, {
    choice: decided.choice,
  });
  if (status === "unknown") return false;
  if (status === "answered")
    broker.emit(entry, "request.answered", "system", "success", decided.decision, {
      auto: true,
    });
  return true;
}
