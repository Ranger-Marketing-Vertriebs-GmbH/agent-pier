export function questionsView(questions, tool) {
  return questions.map((question, index) => ({
    id: `q${index}`,
    header: question.header || "",
    prompt: question.question,
    options: (question.options || []).map((option) => ({
      id: option.label,
      label: option.label,
      description: option.description || "",
    })),
    multiple:
      tool === "claude"
        ? question.multiSelect === true
        : tool === "opencode"
          ? question.multiple === true
          : false,
    allowOther:
      tool === "codex"
        ? question.isOther === true || !question.options?.length
        : tool === "opencode"
          ? question.custom !== false
          : true,
    ...(question.isSecret ? { secret: true } : {}),
  }));
}
export function questionAnswers(questions, answers) {
  // Native labels are the selection values, so arbitrary free text cannot collide with invented IDs.
  return questions.map((_question, index) => [...answers[`q${index}`]]);
}
