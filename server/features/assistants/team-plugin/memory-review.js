import { completionFailure, valid, withLeastReasoning } from "./chat-title.js";

// The memory review after a model switch (memory-review.js): AgentPier asks the
// agent's new model which memory entries only record a model's own refusals or
// limits. Like the chat title (chat-title.js) it is one `api.runtime.llm.complete` in
// isolated mode on the agent's model and login, with a fresh context and no tools: no
// session, transcript or chat history, so nothing shows in a chat. It reads the
// memory text AgentPier sends and writes nothing.
export const memoryReviewMethod = "agentpier.memoryReview";
// The most memory text one review sends (memory-review.js keeps below it).
export const memoryReviewInputLimit = 64000;
export const memoryReviewTimeoutMs = 120000;
const instructionsLimit = 8000;
const answerLimit = 64000;

/**
 * Registers the review method, admin-only: only AgentPier holds that scope. A failure
 * answers UNAVAILABLE with OpenClaw's stable failure code, never content.
 */
export function registerMemoryReview(api) {
  api.registerGatewayMethod?.(
    memoryReviewMethod,
    async ({ params, respond }) => {
      const { agentId, instructions, input } = params || {};
      if (
        !valid(agentId, 100) ||
        !valid(instructions, instructionsLimit) ||
        !valid(input, memoryReviewInputLimit)
      )
        return respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "invalid memory review request",
        });
      try {
        const result = await withLeastReasoning((reasoning) =>
          api.runtime.llm.complete({
            agentId,
            systemPrompt: instructions,
            messages: [{ role: "user", content: input }],
            purpose: "memory-review",
            maxTokens: 4000,
            ...(reasoning && { reasoning }),
            execution: {
              mode: "isolated-agent-runtime",
              timeoutMs: memoryReviewTimeoutMs,
            },
          }),
        );
        const text = (typeof result?.text === "string" ? result.text : "")
          .replace(/<think>[\s\S]*?(<\/think>|$)/giu, "")
          .trim();
        respond(true, { text: text.slice(0, answerLimit) });
      } catch (error) {
        respond(false, undefined, completionFailure(error));
      }
    },
    { scope: "operator.admin" },
  );
}
