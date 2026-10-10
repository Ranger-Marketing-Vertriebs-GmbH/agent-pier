import api from "../../lib/api.js";
const base = (id) => `/assistants/${encodeURIComponent(id)}/routines`;
const item = (id, routineId) => `${base(id)}/${encodeURIComponent(routineId)}`;
export const routineApi = {
  list: (id) => api(base(id)),
  create: (id, input) => api(base(id), "POST", input),
  update: (id, routineId, input) => api(item(id, routineId), "PATCH", input),
  remove: (id, routineId) => api(item(id, routineId), "DELETE"),
  trigger: (id, routineId, input) => api(`${item(id, routineId)}/events`, "POST", input),
};
