import api from "../../lib/api.js";

// The owner's split views (server/http/routes/views.js). Every write answers the
// document's new `version`, and the view it wrote.
const at = (id) => `/views/${encodeURIComponent(id)}`;

export const listViews = () => api("/views");
export const createView = ({ name, layout }) => api("/views", "POST", { name, layout });
export const updateView = (id, patch) => api(at(id), "PATCH", patch);
export const deleteView = (id) => api(at(id), "DELETE");
