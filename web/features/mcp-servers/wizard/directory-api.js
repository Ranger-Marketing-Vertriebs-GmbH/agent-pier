import api from "../../../lib/api.js";

/** Browser calls to the read-only MCP directory; each one follows an owner action. */
export const directoryApi = {
  status: () => api("/mcp-directory/status"),
  search: (search, cursor = "") =>
    api(
      `/mcp-directory/servers?search=${encodeURIComponent(search)}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    ),
  detail: (name) => api(`/mcp-directory/servers/${encodeURIComponent(name)}`),
  updates: () => api("/mcp-directory/updates"),
};
