import { isMainModule } from "../../lib/is-main-module.js";
import { randomUUID } from "node:crypto";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import { NativeRequestChannel } from "./native-channel.js";
import { questionsView, questionAnswers, claudeAnnotations } from "./native-questions.js";
import { claudeHookVersion, claudeHookTimeoutSeconds } from "./claude-runtime.js";
import { requestValue } from "./request-validation.js";
import { watchNativeDecision } from "./claude-native-decision.js";

// Without a transcript match a terminal approval cannot be observed, so such a
// permission keeps the earlier bounded wait instead of holding chat for a day.
const unmatchedPermissionMs = 590000;

// Model-facing text stays English like Claude's own tool results.
function declineReason(questions, notes = {}) {
  const details = questions
    .map((question, i) => notes[`q${i}`] && `"${question.question}": ${notes[`q${i}`]}`)
    .filter(Boolean);
  return [
    "The user declined to answer these questions in AgentPier chat. Do not assume any answer.",
    ...(details.length ? [`User notes: ${details.join("; ")}`] : []),
  ].join("\n");
}
const trimmed = (value, limit) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
// Reads a quoted `key: "…"` literal from a Workflow script's `meta` object.
// Text only: the script is never evaluated.
function metaLiteral(source, key) {
  const match = new RegExp(
    `(?:^|[\\s,{])${key}\\s*:\\s*(?:"((?:[^"\\\\\\n]|\\\\.){0,4000})"|'((?:[^'\\\\\\n]|\\\\.){0,4000})'|\`((?:[^\`\\\\$]|\\\\.){0,4000})\`)`,
  ).exec(source);
  const raw = match && (match[1] ?? match[2] ?? match[3]);
  return raw && raw.replace(/\\(.)/g, (_, char) => (char === "n" ? " " : char));
}
function workflowSummary(input) {
  let meta = input?.meta;
  if (!meta || typeof meta !== "object") {
    const script = typeof input?.script === "string" ? input.script.slice(0, 65536) : "";
    const start = script.search(/\bmeta\s*=\s*\{/);
    if (start < 0) return undefined;
    const source = script.slice(start, start + 16384);
    meta = {
      name: metaLiteral(source, "name"),
      description: metaLiteral(source, "description"),
    };
  }
  const parts = [trimmed(meta.name, 200), trimmed(meta.description, 1500)].filter(
    Boolean,
  );
  return parts.length ? parts.join(": ") : undefined;
}
function permissionDescription(data) {
  return (
    trimmed(data.tool_input?.description, 2000) ??
    (data.tool_name === "Workflow" ? workflowSummary(data.tool_input) : undefined)
  );
}
export function claudeRequest(data) {
  if (
    ["PreToolUse", "PermissionRequest"].includes(data.hook_event_name) &&
    data.tool_name === "AskUserQuestion"
  ) {
    // After a PreToolUse timeout or handoff, Claude can ask again through
    // PermissionRequest. It still needs answers, not a bare tool approval.
    const questions = data.tool_input?.questions;
    if (!Array.isArray(questions) || !questions.length) return null;
    const permission = data.hook_event_name === "PermissionRequest";
    return {
      view: {
        kind: "question",
        questions: questionsView(questions, "claude"),
        declinable: true,
      },
      answer: (input) => {
        if (input.handoff) return null;
        if (input.decline) {
          const reason = declineReason(questions, input.notes);
          return {
            hookSpecificOutput: permission
              ? {
                  hookEventName: "PermissionRequest",
                  decision: { behavior: "deny", message: reason },
                }
              : {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: reason,
                },
          };
        }
        const annotations = claudeAnnotations(questions, input);
        const updatedInput = {
          ...data.tool_input,
          answers: Object.fromEntries(
            questionAnswers(questions, input.answers).map((answers, i) => [
              questions[i].question,
              answers.join(", "),
            ]),
          ),
          ...(annotations ? { annotations } : {}),
        };
        return {
          hookSpecificOutput: permission
            ? {
                hookEventName: "PermissionRequest",
                decision: { behavior: "allow", updatedInput },
              }
            : {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput,
              },
        };
      },
    };
  }
  if (data.hook_event_name === "PermissionRequest")
    return {
      view: {
        kind: "permission",
        subject: {
          tool: data.tool_name,
          command: data.tool_input?.command,
          // EnterWorktree names its target as `path`.
          path:
            data.tool_input?.file_path ??
            (typeof data.tool_input?.path === "string"
              ? data.tool_input.path
              : undefined),
          cwd: data.cwd,
          description: permissionDescription(data),
        },
        options: [
          { id: "allow", label: copy.once, scope: "once" },
          { id: "deny", label: copy.deny },
        ],
      },
      answer: (input) =>
        input.handoff
          ? null
          : {
              hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: { behavior: input.choice },
              },
            },
    };
  return null;
}
export async function runClaudeHook({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  timeout,
} = {}) {
  let text = "";
  for await (const chunk of input) {
    text += chunk;
    if (text.length > 1024 * 1024) return;
  }
  const data = JSON.parse(text);
  const request = claudeRequest(data);
  if (!request) return;
  // Unsupported payloads must fall back to Claude, not reconnect indefinitely
  // after the broker rejects the same unrenderable request.
  requestValue(request.view);
  let channel, outcome;
  // The hook invocation is the return channel; no fabricated provider request ID.
  const key = randomUUID();
  await new Promise((resolve) => {
    let finished = false;
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      outcome = reason;
      clearTimeout(timer);
      clearTimeout(unmatched);
      clearTimeout(connectTimer);
      stopWatching();
      resolve();
    };
    // Questions and permissions share one lifetime: both wait in chat until
    // shortly before Claude's own hook timeout, a terminal handoff, or a
    // decision in Claude's own dialog.
    const timer = setTimeout(
      () => finish("timeout"),
      timeout ?? claudeHookTimeoutSeconds * 1000 - 10000,
    );
    const unmatched =
      request.view.kind === "permission" && timeout === undefined
        ? setTimeout(() => finish("timeout"), unmatchedPermissionMs)
        : undefined;
    const stopWatching =
      data.hook_event_name === "PermissionRequest"
        ? watchNativeDecision({
            transcriptPath: data.transcript_path,
            toolName: data.tool_name,
            toolInput: data.tool_input,
            onMatched: () => clearTimeout(unmatched),
            onSettled: () => finish("native"),
          })
        : () => {};
    const connectTimer = setTimeout(() => finish(), 10000);
    channel = new NativeRequestChannel({
      env,
      adapterVersion: claudeHookVersion,
      // A waiting request still belongs to this live invocation during a
      // server restart. Republish it after reconnect instead of losing it.
      onDisconnect: () => {},
    });
    channel.ready.then(() => {
      clearTimeout(connectTimer);
      if (finished) return;
      channel.publish(key, request.view, async (answer) => {
        try {
          const result = request.answer(answer);
          if (result)
            await new Promise((resolve, reject) =>
              output.write(JSON.stringify(result) + "\n", (error) =>
                error ? reject(error) : resolve(),
              ),
            );
        } finally {
          // Let the transport acknowledge the consumed occurrence before exiting
          // the hook. A failed delivery also exits, so Claude falls back to its
          // own dialog instead of waiting for the hook timeout.
          setTimeout(() => finish(), 25);
        }
      });
    });
  });
  // Tell chat why the request ended: after a timeout Claude's own dialog is
  // the only one left; after a native decision nothing is waiting any more.
  channel.resolve(key, outcome);
  channel.close();
}
if (isMainModule(import.meta.url)) {
  try {
    await runClaudeHook();
  } catch {
    /* A missing bridge leaves the native permission flow in control. */
  }
}
