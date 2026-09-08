import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import { questionsView, questionAnswers } from "./native-questions.js";

/** Installed 0.153.4 generated protocol. Unknown methods remain owned by the real TUI. */
export function codexRequest(message) {
  if (
    message.id === undefined ||
    !message.params ||
    typeof message.params.threadId !== "string"
  )
    return null;
  const { id, method, params: p } = message;
  const subject = {
    tool: method,
    ...(p.command ? { command: p.command } : {}),
    ...(p.cwd ? { cwd: p.cwd } : {}),
    ...(p.reason ? { description: p.reason } : {}),
    ...(p.grantRoot ? { path: p.grantRoot } : {}),
  };
  if (
    method === "item/tool/requestUserInput" &&
    Array.isArray(p.questions) &&
    p.questions.length
  )
    return {
      view: { kind: "question", questions: questionsView(p.questions, "codex") },
      answer: (input) => ({
        id,
        result: {
          answers: Object.fromEntries(
            questionAnswers(p.questions, input.answers).map((answers, i) => [
              p.questions[i].id,
              { answers },
            ]),
          ),
        },
      }),
    };
  if (method === "item/permissions/requestApproval")
    return {
      view: {
        kind: "permission",
        subject: {
          ...subject,
          description: [p.reason, JSON.stringify(p.permissions, null, 2)]
            .filter(Boolean)
            .join("\n"),
        },
        options: [
          { id: "allow", label: copy.turnAllow, scope: "turn" },
          { id: "deny", label: copy.deny },
        ],
      },
      answer: (input) => ({
        id,
        result: {
          permissions:
            input.choice === "allow"
              ? Object.fromEntries(
                  Object.entries(p.permissions || {}).filter(
                    ([, value]) => value !== null,
                  ),
                )
              : {},
          scope: "turn",
        },
      }),
    };
  if (
    ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(
      method,
    )
  ) {
    const names = {
      accept: copy.once,
      acceptForSession: copy.sessionAllow,
      decline: copy.deny,
      cancel: copy.cancel,
    };
    const decisions = p.availableDecisions || ["accept", "decline"];
    // Policy amendment objects need additional disclosure; leave those choices in the native TUI.
    const options = decisions
      .filter((value) => typeof value === "string" && Object.hasOwn(names, value))
      .map((value) => ({
        id: value,
        label: names[value],
        ...(value === "acceptForSession"
          ? { scope: "session" }
          : value === "accept"
            ? { scope: "once" }
            : {}),
      }));
    if (!options.length) return null;
    return {
      view: { kind: "permission", subject, options },
      answer: (input) => ({ id, result: { decision: input.choice } }),
    };
  }
  return null;
}
