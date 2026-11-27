/** Copy for an agent's questions in the paired Telegram chat (agent-questions.js). */
export const agentQuestions = Object.freeze({
  telegramQuestion: (name, question) => `${name} asks: ${question}`,
  telegramQuestionStep: (name, number, total, question) =>
    `${name} asks (${number} of ${total}): ${question}`,
  telegramQuestionChoices: "Reply with a number or with your own answer.",
  telegramQuestionSeveral:
    "Reply with one or more numbers, separated by commas, or with your own answer.",
  telegramQuestionAnswer: "Send your answer as a message.",
  telegramQuestionAnswered: "Answer sent to the agent.",
});
