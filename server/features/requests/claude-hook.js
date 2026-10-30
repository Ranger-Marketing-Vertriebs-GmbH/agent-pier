import { isMainModule } from "../../lib/is-main-module.js";
import { randomUUID } from "node:crypto";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import { NativeRequestChannel } from "./native-channel.js";
import { questionsView, questionAnswers, claudeAnnotations } from "./native-questions.js";
import { claudeHookVersion, claudeHookTimeoutSeconds } from "./claude-runtime.js";
import { requestValue } from "./request-validation.js";
import { handoverState, handOver, hookScript, outdated } from "./claude-hook-handover.js";
import { subagentTranscriptPath, watchNativeDecision } from "./claude-native-decision.js";
import { workflowMeta } from "./claude-workflow-meta.js";
import {
  alwaysDecision,
  persistentRules,
  planRequest,
  ruleText,
} from "./claude-permission.js";

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
// Workflow approvals name their script: `meta.name` beside the tool, and
// `meta.description` as the description.
function workflowMetaOf(data) {
  if (data.tool_name !== "Workflow") return {};
  const input = data.tool_input;
  const meta =
    input?.meta && typeof input.meta === "object"
      ? input.meta
      : workflowMeta(input?.script);
  return {
    name: trimmed(meta?.name, 200),
    description: trimmed(meta?.description, 1500),
  };
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
  if (data.hook_event_name === "PermissionRequest" && data.tool_name === "ExitPlanMode") {
    const plan = planRequest(data);
    if (plan) return plan;
  }
  if (data.hook_event_name === "PermissionRequest") {
    const workflow = workflowMetaOf(data);
    const rules = persistentRules(data.permission_suggestions);
    return {
      view: {
        kind: "permission",
        subject: {
          tool: data.tool_name,
          command: data.tool_input?.command,
          // EnterWorktree names its target as `path`; for Glob/Grep it is only
          // a search root, so other tools keep their tool name as the subject.
          path:
            data.tool_input?.file_path ??
            (data.tool_name === "EnterWorktree" &&
            typeof data.tool_input?.path === "string"
              ? data.tool_input.path
              : undefined),
          name: workflow.name,
          cwd: data.cwd,
          // Only a subagent (or teammate) carries agent_id; a session started
          // with --agent has agent_type alone and asks as the main agent.
          agent: data.agent_id ? trimmed(data.agent_type, 200) : undefined,
          description:
            trimmed(data.tool_input?.description, 2000) ?? workflow.description,
        },
        options: [
          { id: "allow", label: copy.once, scope: "once" },
          // Offered only for rules Claude itself proposes for this call.
          ...(rules.length
            ? [
                {
                  id: "always",
                  label: copy.always,
                  description: rules.map(ruleText).join("\n"),
                  scope: "persistent",
                },
              ]
            : []),
          { id: "deny", label: copy.deny },
        ],
      },
      answer: (input) =>
        input.handoff
          ? null
          : {
              hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision:
                  input.choice === "always"
                    ? alwaysDecision(rules)
                    : { behavior: input.choice },
              },
            },
    };
  }
  return null;
}
/**
 * `script` is the file this invocation runs from; a broker that runs a newer release
 * names another one, and the hook hands its request over (claude-hook-handover.js).
 */
export async function runClaudeHook({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  timeout,
  script = hookScript,
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
  let channel, outcome, successor;
  // A hook that took over from an older release keeps its key, epoch and deadline,
  // so the broker sees the same request.
  const inherited = handoverState(env);
  // The hook invocation is the return channel; no fabricated provider request ID.
  const key = inherited?.key ?? randomUUID();
  const deadline =
    inherited?.deadline ??
    Date.now() + (timeout ?? claudeHookTimeoutSeconds * 1000 - 10000);
  await new Promise((resolve) => {
    let finished = false;
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      outcome = reason;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      stopWatching();
      resolve();
    };
    // Questions and permissions share one lifetime: both wait in chat until
    // shortly before Claude's own hook timeout, a terminal handoff, a decision in
    // Claude's own dialog or a later call that shows Claude moved on. A permission
    // Claude's transcript does not show keeps that lifetime too.
    const timer = setTimeout(() => finish("timeout"), Math.max(0, deadline - Date.now()));
    // A subagent's call is only in its own transcript. The session transcript is
    // not watched beside it: an identical main-agent call there would settle the
    // wrong request. Without a usable agent id the session transcript remains.
    const stopWatching =
      data.hook_event_name === "PermissionRequest"
        ? watchNativeDecision({
            transcriptPath:
              subagentTranscriptPath(data.transcript_path, data.agent_id) ??
              data.transcript_path,
            toolName: data.tool_name,
            toolInput: data.tool_input,
            onSettled: (reason) => finish(reason),
          })
        : () => {};
    const connectTimer = setTimeout(() => finish(), 10000);
    channel = new NativeRequestChannel({
      env,
      adapterVersion: claudeHookVersion,
      epoch: inherited?.epoch,
      // A broker of a newer release names its hook: this invocation's code is
      // outdated, so the current one takes the waiting request over.
      onReady: (ready) => {
        if (finished || !outdated(ready.hook, script, inherited)) return;
        channel.release();
        successor = handOver({
          env,
          text,
          output,
          state: {
            key,
            epoch: channel.epoch,
            deadline,
            hops: (inherited?.hops ?? 0) + 1,
          },
        });
        finish("handover");
      },
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
  // The successor owns the request now and answers Claude through this output.
  if (successor) {
    await successor;
    channel.close();
    return;
  }
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
