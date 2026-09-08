import { isMainModule } from "../../lib/is-main-module.js";
import { randomUUID } from "node:crypto";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import { NativeRequestChannel } from "./native-channel.js";
import { questionsView, questionAnswers } from "./native-questions.js";

export function claudeRequest(data) {
  if (data.hook_event_name === "PermissionRequest")
    return {
      view: {
        kind: "permission",
        subject: {
          tool: data.tool_name,
          command: data.tool_input?.command,
          path: data.tool_input?.file_path,
          cwd: data.cwd,
          description: data.tool_input?.description,
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
  if (
    data.hook_event_name === "PreToolUse" &&
    data.tool_name === "AskUserQuestion" &&
    Array.isArray(data.tool_input?.questions)
  ) {
    const questions = data.tool_input.questions;
    return {
      view: { kind: "question", questions: questionsView(questions, "claude") },
      answer: (input) =>
        input.handoff
          ? null
          : {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput: {
                  ...data.tool_input,
                  answers: Object.fromEntries(
                    questionAnswers(questions, input.answers).map((answers, i) => [
                      questions[i].question,
                      answers.join(", "),
                    ]),
                  ),
                },
              },
            },
    };
  }
  return null;
}
export async function runClaudeHook({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  timeout = 590000,
} = {}) {
  let text = "";
  for await (const chunk of input) {
    text += chunk;
    if (text.length > 1024 * 1024) return;
  }
  const data = JSON.parse(text);
  const request = claudeRequest(data);
  if (!request) return;
  let channel;
  // The hook invocation is the return channel; no fabricated provider request ID.
  const key = randomUUID();
  await new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      finished = true;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    const connectTimer = setTimeout(finish, 1500);
    channel = new NativeRequestChannel({ env, onDisconnect: finish });
    channel.ready.then(() => {
      clearTimeout(connectTimer);
      if (finished) return;
      channel.publish(key, request.view, async (answer) => {
        const result = request.answer(answer);
        if (result) output.write(JSON.stringify(result) + "\n");
        // Let the transport acknowledge the consumed occurrence before exiting the hook.
        setTimeout(finish, 25);
      });
    });
  });
  channel.resolve(key);
  channel.close();
}
if (isMainModule(import.meta.url)) {
  try {
    await runClaudeHook();
  } catch {
    /* A missing bridge leaves the native permission flow in control. */
  }
}
