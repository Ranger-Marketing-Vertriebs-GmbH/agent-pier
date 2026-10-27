/** Owner-facing copy of agents' coding sessions (assistantProblem keys). */
export const agentCodingSessions = Object.freeze({
  sessionsNotEnabled:
    "Coding-Sessions sind für diesen Agenten in keinem Projekt aktiviert.",
  grantRevoked:
    "Der Agent darf diese Coding-Session nicht mehr steuern: Freigabe oder Projektzugriff wurde entzogen.",
  sessionLimit: "Der Agent hat bereits die höchste Zahl gleichzeitiger Coding-Sessions.",
  promptAnswered:
    "Diese Rückfrage der Session wurde bereits beantwortet oder hat sich geändert.",
  sessionRunning: "Die Session arbeitet noch.",
  worktreeDirty: "Der Worktree enthält nicht übernommene Änderungen und bleibt bestehen.",
  worktreeNotMerged:
    "Der Branch des Worktrees ist noch nicht in seinen Basis-Branch auf origin übernommen; der Worktree bleibt bestehen.",
  noRepository:
    "Der Projektordner ist kein Git-Repository mit einem origin-Remote; ein Worktree ist nicht möglich.",
  // Telegram: an agent's escalated session prompt (session-escalation-notes.js).
  escalationTelegram: (agent, session) =>
    `${agent} braucht deine Antwort in der Session ${session}:`,
  escalationNote: "Notiz des Agenten:",
  escalationReplyHint: "Antworte auf diese Nachricht, um eigenen Text zu senden.",
  escalationAnswerInApp: "Diese Rückfrage lässt sich nur in AgentPier beantworten.",
  escalationAnsweredBy: Object.freeze({
    owner: "In AgentPier beantwortet.",
    agent: "Vom Agenten beantwortet.",
    telegram: "In Telegram beantwortet.",
    session: "Die Session wartet nicht mehr auf diese Antwort.",
  }),
  escalationStale: "Diese Rückfrage wurde bereits beantwortet oder hat sich geändert.",
  // Telegram: what an agent's coding session start would launch (approval).
  startLaunch: Object.freeze({
    mode: (mode) => `Startmodus: ${mode}`,
    unattended: "unbeaufsichtigt: führt Befehle ohne Rückfrage aus",
    account: (name) => `Konto: ${name}`,
    connection: (name) => `Verbindung: ${name}`,
    model: (model) => `Modell: ${model}`,
    access: (secrets, ssh) => `Secrets: ${secrets} · SSH-Zugänge: ${ssh}`,
    sandbox: (profile) => `Sandbox-Profil: ${profile}`,
    noSandbox: "Sandbox-Profil: keins",
    tools: (tools, bus) => `AgentPier-Tools: ${tools} · AgentBus: ${bus}`,
    on: "an",
    off: "aus",
  }),
});
