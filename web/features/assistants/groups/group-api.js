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

/**
 * How the owner's views save a move of the agent order (useAgentOrdering.jsx): the
 * order, then the list read again; a drop into another group assigns it there first.
 */
export const ownerOrderWrites = (refresh) => ({
  save: async (ids) => {
    await groupApi.saveOrder(ids);
    await refresh();
  },
  regroup: (id, from, to) =>
    groupApi.assign(
      id,
      to === "ungrouped" ? null : to,
      from === "ungrouped" ? null : from,
    ),
});
