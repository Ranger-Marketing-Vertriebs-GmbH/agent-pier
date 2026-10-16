import { assistantApi } from "../../assistants/assistant-api.js";

/** The calls runConnect makes; the server record is read fresh from the list. */
export const connectApi = (data) => ({
  server: async (id) => (await data.reloadMcp())?.find((item) => item.id === id),
  updateServer: (id, body) => assistantApi.updateMcpServer(id, body),
  assistants: async () => (await assistantApi.list())?.assistants ?? [],
  updateAssistant: (id, body) => assistantApi.update(id, body),
});
