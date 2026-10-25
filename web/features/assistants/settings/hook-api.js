import api from "../../../lib/api.js";
const base = (id) => `/assistants/${encodeURIComponent(id)}/hooks`;
const item = (id, hookId) => `${base(id)}/${encodeURIComponent(hookId)}`;
// The owner's hook routes (server/http/routes/assistant-hooks.js).
export const hookApi = {
  list: (id) => api(base(id)),
  create: (id, input) => api(base(id), "POST", input),
  update: (id, hookId, input) => api(item(id, hookId), "PATCH", input),
  remove: (id, hookId) => api(item(id, hookId), "DELETE"),
  secret: (id, hookId, revision) =>
    api(`${item(id, hookId)}/secret`, "POST", { revision }),
  test: (id, hookId) => api(`${item(id, hookId)}/test`, "POST", {}),
  event: (id, hookId, eventId) =>
    api(`${item(id, hookId)}/events/${encodeURIComponent(eventId)}`),
};
