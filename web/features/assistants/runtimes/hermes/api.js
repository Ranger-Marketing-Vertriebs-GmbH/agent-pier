import api from "../../../../lib/api.js";

// Hermes Agent's own routes: the owner's switch and the update. Its state is read
// from the runtime list (the live topic `runtimes`, useRuntimes.js).
export const hermesApi = {
  set: (enabled) => api("/assistant-runtime/hermes", "PUT", { enabled }),
  update: () => api("/assistant-runtime/hermes/update", "POST", {}),
};
