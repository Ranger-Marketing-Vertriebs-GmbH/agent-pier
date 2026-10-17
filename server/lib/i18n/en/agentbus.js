/** English product copy, addressed through the same semantic keys as the German catalog. */
export const agentbus = Object.freeze({
  invalidSession: "Invalid AgentBus session.",
  sessionAlreadyExists: "The AgentBus session already exists.",
  codexRegistrationPending:
    "Not registered yet. If Codex reports hooks for review, open /hooks and review the AgentBus hooks.",
  nativeRegistrationPending: "The native AgentBus extension has not registered yet.",
  overviewNotice:
    "Only enabled AgentPier sessions in the same project exchange messages. This overview does not read any messages or mark anything as read. Codex may require a native review of new hooks.",
  invalidHistoryPage: "Invalid AgentBus history page.",
  projectNotFound: "AgentBus project not found.",
  historyScanLimit:
    "The view is limited to 5,000 scanned files; more messages may exist.",
  sendBudgetSender: (limit, seconds) =>
    `SEND_BUDGET: This session already sent ${limit} messages in the last minute. Wait ${seconds} seconds before sending again.`,
  sendBudgetPair: (limit, name) =>
    `SEND_BUDGET: This session already sent ${limit} messages to ${name} in the last 10 minutes. Do not retry; tell the user or wait for their instruction.`,
  sendBudgetDepth: (limit) =>
    `SEND_BUDGET: This reply chain already reached ${limit} messages. Do not retry; tell the user or wait for their instruction. Start a new thread without replyTo only if the user asked for further coordination.`,
});
