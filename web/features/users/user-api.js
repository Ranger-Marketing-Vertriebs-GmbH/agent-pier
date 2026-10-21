import api from "../../lib/api.js";

// The restricted user's API: only /api/me routes. Her app never calls an owner route.
const id = (value) => encodeURIComponent(value);
const agent = (agentId) => `/me/agents/${id(agentId)}`;
const chat = (conversationId) => `/me/conversations/${id(conversationId)}`;

export const userApi = {
  me: () => api("/me"),
  changePassword: (body) => api("/me/password", "PUT", body),
  agents: () => api("/me/agents"),
  // Her main chat with the agent, opened when she has none yet.
  open: (agentId) => api(`${agent(agentId)}/conversation`, "POST", {}),
  chats: (agentId, archived = false) =>
    api(`${agent(agentId)}/chats${archived ? "?archived=1" : ""}`),
  newChat: (agentId) => api(`${agent(agentId)}/chats`, "POST", {}),
  renameChat: (conversationId, title) => api(chat(conversationId), "PATCH", { title }),
  archiveChat: (conversationId) => api(`${chat(conversationId)}/archive`, "POST", {}),
  restoreChat: (conversationId) => api(`${chat(conversationId)}/restore`, "POST", {}),
  deleteChat: (conversationId) => api(chat(conversationId), "DELETE", { confirm: true }),
  history: (conversationId, before) =>
    api(
      `${chat(conversationId)}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    ),
  feed: (conversationId, cursor, signal) =>
    api(
      `${chat(conversationId)}/messages?cursor=${encodeURIComponent(cursor || "")}`,
      "GET",
      undefined,
      signal,
    ),
  send: (conversationId, body) => api(`${chat(conversationId)}/messages`, "POST", body),
  queue: (conversationId, body) => api(`${chat(conversationId)}/queued`, "POST", body),
  takeBackQueued: (conversationId) => api(`${chat(conversationId)}/queued`, "DELETE"),
  cancel: (attemptId) => api(`/me/attempts/${id(attemptId)}/cancel`, "POST", {}),
  recover: (attemptId) =>
    api(`/me/attempts/${id(attemptId)}/recover`, "POST", {
      acknowledgeUnknownOutcome: true,
    }),
  settings: (agentId) => api(`${agent(agentId)}/settings`),
  saveSettings: (agentId, values, revision) =>
    api(`${agent(agentId)}/settings`, "PATCH", { values, revision }),
  memory: (agentId) => api(`${agent(agentId)}/memory`),
  removeMemory: (agentId, name) => api(`${agent(agentId)}/memory/${id(name)}`, "DELETE"),
  reminders: (agentId, kind = "reminders") => api(`${agent(agentId)}/${kind}`),
  createReminder: (agentId, input, kind = "reminders") =>
    api(`${agent(agentId)}/${kind}`, "POST", input),
  updateReminder: (agentId, bindingId, input, kind = "reminders") =>
    api(`${agent(agentId)}/${kind}/${id(bindingId)}`, "PATCH", input),
  removeReminder: (agentId, bindingId, kind = "reminders") =>
    api(`${agent(agentId)}/${kind}/${id(bindingId)}`, "DELETE"),
  telegram: (agentId) => api(`${agent(agentId)}/telegram`),
  browser: (agentId, signal) =>
    api(`${agent(agentId)}/browser`, "GET", undefined, signal),
  approvals: () => api("/me/approvals"),
  decide: (actionId, body) => api(`/me/approvals/${id(actionId)}/decision`, "POST", body),
};
