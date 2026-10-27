/** Owner-facing copy of agents' coding sessions (assistantProblem keys). */
export const agentCodingSessions = Object.freeze({
  sessionsNotEnabled:
    "Coding sessions are not switched on for this agent in any project.",
  grantRevoked:
    "The agent may no longer control this coding session: its access or the project grant was removed.",
  sessionLimit: "The agent already runs the most coding sessions allowed at a time.",
  promptAnswered: "This prompt of the session was already answered or has changed.",
  sessionRunning: "The session is still working.",
  worktreeDirty: "The worktree has uncommitted changes and is kept.",
  worktreeNotMerged:
    "The worktree's branch is not merged into its base branch on origin yet; the worktree is kept.",
  noRepository:
    "The project folder is not a Git repository with an origin remote; a worktree is not possible.",
  // Telegram: an agent's escalated session prompt (session-escalation-notes.js).
  escalationTelegram: (agent, session) =>
    `${agent} needs your answer in the session ${session}:`,
  escalationNote: "Note from the agent:",
  escalationReplyHint: "Reply to this message to send your own text.",
  escalationAnswerInApp: "This prompt can only be answered in AgentPier.",
  escalationAnsweredBy: Object.freeze({
    owner: "Answered in AgentPier.",
    agent: "Answered by the agent.",
    telegram: "Answered in Telegram.",
    session: "The session no longer waits for this answer.",
  }),
  escalationStale: "This prompt was already answered or has changed.",
  // Telegram: what an agent's coding session start would launch (approval).
  startLaunch: Object.freeze({
    mode: (mode) => `Launch mode: ${mode}`,
    unattended: "unattended: runs commands without asking",
    account: (name) => `Account: ${name}`,
    connection: (name) => `Connection: ${name}`,
    model: (model) => `Model: ${model}`,
    access: (secrets, ssh) => `Secrets: ${secrets} · SSH accesses: ${ssh}`,
    sandbox: (profile) => `Sandbox profile: ${profile}`,
    noSandbox: "Sandbox profile: none",
    tools: (tools, bus) => `AgentPier tools: ${tools} · AgentBus: ${bus}`,
    on: "on",
    off: "off",
  }),
});
