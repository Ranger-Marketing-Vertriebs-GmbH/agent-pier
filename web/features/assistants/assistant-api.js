import api from "../../lib/api.js";
export const assistantApi = {
  deleteSharedFile: (conversationId, fileId) =>
    api(
      `/assistant-conversations/${encodeURIComponent(conversationId)}/shared-files/${encodeURIComponent(fileId)}`,
      "DELETE",
    ),
  feature: () => api("/assistant-feature"),
  setFeature: (enabled) => api("/assistant-feature", "PUT", { enabled }),
  memory: (id, name) =>
    api(`/assistants/${encodeURIComponent(id)}/memory?name=${encodeURIComponent(name)}`),
  memoryFiles: (id) => api(`/assistants/${encodeURIComponent(id)}/memory/files`),
  saveMemory: (id, input) =>
    api(`/assistants/${encodeURIComponent(id)}/memory`, "PUT", input),
  searchMemory: (id, query) =>
    api(
      `/assistants/${encodeURIComponent(id)}/memory/search?q=${encodeURIComponent(query)}`,
    ),
  reminders: (id) => api(`/assistants/${encodeURIComponent(id)}/reminders`),
  createReminder: (id, input) =>
    api(`/assistants/${encodeURIComponent(id)}/reminders`, "POST", input),
  updateReminder: (id, reminderId, input) =>
    api(
      `/assistants/${encodeURIComponent(id)}/reminders/${encodeURIComponent(reminderId)}`,
      "PATCH",
      input,
    ),
  removeReminder: (id, reminderId) =>
    api(
      `/assistants/${encodeURIComponent(id)}/reminders/${encodeURIComponent(reminderId)}`,
      "DELETE",
    ),
  reviewReminder: (id, reminderId) =>
    api(
      `/assistants/${encodeURIComponent(id)}/reminders/${encodeURIComponent(reminderId)}/review`,
      "POST",
      { acknowledgeUnknownOutcome: true },
    ),
  reminderRuns: (id, reminderId) =>
    api(
      `/assistants/${encodeURIComponent(id)}/reminders/${encodeURIComponent(reminderId)}/runs`,
    ),
  recoverTeamMember: (id, revision) =>
    api(`/assistant-team-members/${encodeURIComponent(id)}/recover`, "POST", {
      revision,
      acknowledgeUnknownOutcome: true,
    }),
  recoverNotification: (id, notificationId, action) =>
    api(
      `/assistant-channels/${encodeURIComponent(id)}/notifications/${encodeURIComponent(notificationId)}/${action}`,
      "POST",
      {},
    ),
  decideTeam: (id, input) =>
    api(`/assistant-team-proposals/${encodeURIComponent(id)}/decision`, "POST", input),
  teamReport: (teamId, memberId) =>
    api(
      `/assistant-teams/${encodeURIComponent(teamId)}/reports/${encodeURIComponent(memberId)}`,
    ),
  replacedInstructions: (memberId, entryId) =>
    api(
      `/assistant-team-members/${encodeURIComponent(memberId)}/replaced/${encodeURIComponent(entryId)}`,
    ),
  leadRequest: (id) => api(`/assistant-lead-requests/${encodeURIComponent(id)}`),
  cancelLeadRequest: (id) =>
    api(`/assistant-lead-requests/${encodeURIComponent(id)}/cancel`, "POST", {}),
  teamAction: (kind, id, action, revision) =>
    api(
      `/assistant-${kind}/${encodeURIComponent(id)}/${action}`,
      "POST",
      revision === undefined ? {} : { revision },
    ),
  teamPolicy: (id, input) =>
    api(`/assistants/${encodeURIComponent(id)}/team-policy`, "PUT", input),
  saveWork: (id, input) =>
    api(`/assistants/${encodeURIComponent(id)}/work`, "PUT", input),
  teamSettings: (input) => api("/assistant-team-settings", "PUT", input),
  channels: () => api("/assistant-channels"),
  createChannel: (input) => api("/assistant-channels", "POST", input),
  updateChannel: (id, input) =>
    api(`/assistant-channels/${encodeURIComponent(id)}`, "PATCH", input),
  pairChannel: (id, revision, appUrl, language) =>
    api(`/assistant-channels/${encodeURIComponent(id)}/pair`, "POST", {
      revision,
      appUrl,
      language,
    }),
  disconnectChannel: (id, revision) =>
    api(`/assistant-channels/${encodeURIComponent(id)}`, "DELETE", { revision }),
  recoverInput: (id, inputId, action) =>
    api(
      `/assistant-channels/${encodeURIComponent(id)}/inputs/${encodeURIComponent(inputId)}/${action}`,
      "POST",
      {},
    ),
  speech: (signal) => api("/assistant-speech", "GET", undefined, signal),
  saveSpeech: (input) => api("/assistant-speech", "PUT", input),
  telegramSenders: (id, signal) =>
    api(
      `/assistant-telegram-senders/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      signal,
    ),
  saveTelegramSenders: (id, input) =>
    api(`/assistant-telegram-senders/${encodeURIComponent(id)}`, "PUT", input),
  removeTelegramSenders: (id, input) =>
    api(`/assistant-telegram-senders/${encodeURIComponent(id)}`, "DELETE", input),
  applyTelegramSenders: (input) =>
    api("/assistant-telegram-senders/apply", "POST", input),
  webSearch: (signal) => api("/assistant-web-search", "GET", undefined, signal),
  saveWebSearch: (input) => api("/assistant-web-search", "PUT", input),
  pdfModel: (signal) => api("/assistant-pdf-model", "GET", undefined, signal),
  savePdfModel: (input) => api("/assistant-pdf-model", "PUT", input),
  advancedSettings: (signal) =>
    api("/assistant-advanced-settings", "GET", undefined, signal),
  saveAdvancedSetting: (input) => api("/assistant-advanced-settings", "PUT", input),
  mcpServers: () => api("/mcp-servers"),
  createMcpServer: (input) => api("/mcp-servers", "POST", input),
  updateMcpServer: (id, input) =>
    api(`/mcp-servers/${encodeURIComponent(id)}`, "PUT", input),
  removeMcpServer: (id) => api(`/mcp-servers/${encodeURIComponent(id)}`, "DELETE"),
  mcpPackageVersions: (registry, name) =>
    api(
      `/mcp-packages/versions?registry=${encodeURIComponent(registry)}&name=${encodeURIComponent(name)}`,
    ),
  resolveMcpCommand: (name) =>
    api(`/mcp-commands/resolve?name=${encodeURIComponent(name)}`),
  previewMcpPackage: (input) => api("/mcp-packages/preview", "POST", input),
  mcpPackageStatus: (id) => api(`/mcp-servers/${encodeURIComponent(id)}/package`),
  updateMcpPackage: (id, input) =>
    api(`/mcp-servers/${encodeURIComponent(id)}/package/update`, "POST", input),
  reinstallMcpPackage: (id) =>
    api(`/mcp-servers/${encodeURIComponent(id)}/package/reinstall`, "POST", {}),
  chooseMcpPackageProgram: (id, input) =>
    api(`/mcp-servers/${encodeURIComponent(id)}/package/program`, "POST", input),
  mcpPackageSkills: (id) => api(`/mcp-servers/${encodeURIComponent(id)}/package/skills`),
  installMcpPackageSkills: (id, input) =>
    api(`/mcp-servers/${encodeURIComponent(id)}/package/skills`, "POST", input),
  loginMcpServer: (id) =>
    api(`/mcp-servers/${encodeURIComponent(id)}/oauth/login`, "POST", {}),
  logoutMcpServer: (id) =>
    api(`/mcp-servers/${encodeURIComponent(id)}/oauth/logout`, "POST", {}),
  accounts: () => api("/assistant-model-accounts"),
  startLogin: () => api("/assistant-model-login", "POST", {}),
  loginStatus: (id) => api(`/assistant-model-login/${encodeURIComponent(id)}`),
  cancelLogin: (id) => api(`/assistant-model-login/${encodeURIComponent(id)}`, "DELETE"),
  checkAccount: (id) =>
    api(`/assistant-model-accounts/${encodeURIComponent(id)}/check`, "POST", {}),
  refreshAccountModels: (id) =>
    api(`/assistant-model-accounts/${encodeURIComponent(id)}/models/refresh`, "POST", {}),
  logoutAccount: (id) =>
    api(`/assistant-model-accounts/${encodeURIComponent(id)}`, "DELETE"),
  list: () => api("/assistants"),
  runtime: () => api("/assistant-runtime"),
  create: (input) => api("/assistants", "POST", input),
  // Agency agents as templates for new agents (server agency-templates.js).
  templates: ({ q = "", category = "", page = 1 } = {}, signal) =>
    api(
      `/agency/templates?${new URLSearchParams({ q, category, page: String(page) })}`,
      "GET",
      undefined,
      signal,
    ),
  template: (id, revision) =>
    api(
      `/agency/templates/preview?${new URLSearchParams({ id, ...(revision ? { revision } : {}) })}`,
    ),
  update: (id, input) => api(`/assistants/${encodeURIComponent(id)}`, "PATCH", input),
  open: (id) => api(`/assistants/${encodeURIComponent(id)}/conversations`, "POST", {}),
  // Several chats per agent (assistant-chats.js).
  chats: (id, archived = false) =>
    api(`/assistants/${encodeURIComponent(id)}/chats${archived ? "?archived=1" : ""}`),
  newChat: (id) => api(`/assistants/${encodeURIComponent(id)}/chats`, "POST", {}),
  renameChat: (id, title) =>
    api(`/assistant-conversations/${encodeURIComponent(id)}`, "PATCH", { title }),
  archiveChat: (id) =>
    api(`/assistant-conversations/${encodeURIComponent(id)}/archive`, "POST", {}),
  restoreChat: (id) =>
    api(`/assistant-conversations/${encodeURIComponent(id)}/restore`, "POST", {}),
  deleteChat: (id) =>
    api(`/assistant-conversations/${encodeURIComponent(id)}`, "DELETE", {
      confirm: true,
    }),
  history: (id, before) =>
    api(
      `/assistant-conversations/${encodeURIComponent(id)}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    ),
  // The live window as a diff against `cursor` (the chat feed's HTTP fallback).
  feed: (id, cursor, signal) =>
    api(
      `/assistant-conversations/${encodeURIComponent(id)}/messages?cursor=${encodeURIComponent(cursor || "")}`,
      "GET",
      undefined,
      signal,
    ),
  send: (id, input) =>
    api(`/assistant-conversations/${encodeURIComponent(id)}/messages`, "POST", input),
  queue: (id, input) =>
    api(`/assistant-conversations/${encodeURIComponent(id)}/queued`, "POST", input),
  takeBackQueued: (id) =>
    api(`/assistant-conversations/${encodeURIComponent(id)}/queued`, "DELETE"),
  cancel: (id) => api(`/assistant-attempts/${encodeURIComponent(id)}/cancel`, "POST", {}),
  recover: (id) =>
    api(`/assistant-attempts/${encodeURIComponent(id)}/recover`, "POST", {
      acknowledgeUnknownOutcome: true,
    }),
  browserStatus: (id, signal) =>
    api(`/assistants/${encodeURIComponent(id)}/browser`, "GET", undefined, signal),
  attachmentUsage: (id, signal) =>
    api(
      `/assistants/${encodeURIComponent(id)}/attachment-usage`,
      "GET",
      undefined,
      signal,
    ),
  clearAttachments: (id) =>
    api(`/assistants/${encodeURIComponent(id)}/attachments`, "DELETE"),
  browserReset: (id) =>
    api(`/assistants/${encodeURIComponent(id)}/browser/reset`, "POST", {}),
  shellAllowlist: (id) => api(`/assistants/${encodeURIComponent(id)}/shell-allowlist`),
  skills: (id) => api(`/assistants/${encodeURIComponent(id)}/skills`),
  removeShellAllowlistEntry: (id, entry) =>
    api(
      `/assistants/${encodeURIComponent(id)}/shell-allowlist/${encodeURIComponent(entry)}`,
      "DELETE",
    ),
  operate: (action) => api(`/assistant-runtime/${action}`, "POST", {}),
};
