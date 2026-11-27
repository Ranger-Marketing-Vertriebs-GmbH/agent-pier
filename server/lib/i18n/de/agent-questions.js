/** Texte für die Fragen eines Agenten im gekoppelten Telegram-Chat (agent-questions.js). */
export const agentQuestions = Object.freeze({
  telegramQuestion: (name, question) => `${name} fragt: ${question}`,
  telegramQuestionStep: (name, number, total, question) =>
    `${name} fragt (${number} von ${total}): ${question}`,
  telegramQuestionChoices: "Antworte mit einer Nummer oder mit deiner eigenen Antwort.",
  telegramQuestionSeveral:
    "Antworte mit einer oder mehreren Nummern, durch Kommas getrennt, oder mit deiner eigenen Antwort.",
  telegramQuestionAnswer: "Schreib deine Antwort als Nachricht.",
  telegramQuestionAnswered: "Antwort an den Agenten geschickt.",
});
