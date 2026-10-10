import api from "../../lib/api.js";
export const assistantApi = {
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
  teamAction: (kind, id, action, revision) =>
    api(
      `/assistant-${kind}/${encodeURIComponent(id)}/${action}`,
      "POST",
      revision === undefined ? {} : { revision },
    ),
  teamPolicy: (id, input) =>
    api(`/assistants/${encodeURIComponent(id)}/team-policy`, "PUT", input),
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
  accounts: () => api("/assistant-model-accounts"),
  startLogin: () => api("/assistant-model-login", "POST", {}),
  loginStatus: (id) => api(`/assistant-model-login/${encodeURIComponent(id)}`),
  cancelLogin: (id) => api(`/assistant-model-login/${encodeURIComponent(id)}`, "DELETE"),
  checkAccount: (id) =>
    api(`/assistant-model-accounts/${encodeURIComponent(id)}/check`, "POST", {}),
  logoutAccount: (id) =>
    api(`/assistant-model-accounts/${encodeURIComponent(id)}`, "DELETE"),
  list: () => api("/assistants"),
  runtime: () => api("/assistant-runtime"),
  create: (input) => api("/assistants", "POST", input),
  update: (id, input) => api(`/assistants/${encodeURIComponent(id)}`, "PATCH", input),
  open: (id) => api(`/assistants/${encodeURIComponent(id)}/conversations`, "POST", {}),
  history: (id, before) =>
    api(
      `/assistant-conversations/${encodeURIComponent(id)}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    ),
  send: (id, input) =>
    api(`/assistant-conversations/${encodeURIComponent(id)}/messages`, "POST", input),
  cancel: (id) => api(`/assistant-attempts/${encodeURIComponent(id)}/cancel`, "POST", {}),
  recover: (id) =>
    api(`/assistant-attempts/${encodeURIComponent(id)}/recover`, "POST", {
      acknowledgeUnknownOutcome: true,
    }),
  operate: (action) => api(`/assistant-runtime/${action}`, "POST", {}),
};
