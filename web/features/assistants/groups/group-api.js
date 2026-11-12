import api from "../../../lib/api.js";
const path = (id) => `/assistant-groups/${encodeURIComponent(id)}`;
export const groupApi = {
  create: (name) => api("/assistant-groups", "POST", { name }),
  rename: (group, name) =>
    api(path(group.id), "PATCH", { name, revision: group.revision }),
  remove: (group) => api(path(group.id), "DELETE", { revision: group.revision }),
  reorder: (group, direction) =>
    api(`${path(group.id)}/order`, "POST", { direction, revision: group.revision }),
  // The owner's own order of his agent list (server agent-order.js).
  saveOrder: (ids) => api("/assistant-order", "PUT", { ids }),
  assign: (id, groupId, previousGroupId) =>
    api(`/assistants/${encodeURIComponent(id)}/group`, "PUT", {
      groupId,
      previousGroupId,
    }),
};
