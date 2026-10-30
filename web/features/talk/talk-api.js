import api from "../../lib/api.js";
import { observeBuild } from "../../lib/build-check.js";

const json = { "Content-Type": "application/json" };

/** Talk mode's server side (server/http/routes/assistant-talk.js). */
export const talkApi = {
  status: (signal) => api("/assistant-talk", "GET", undefined, signal),
  start: (conversationId) => api("/assistant-talk", "POST", { conversationId }),
  // Also from pagehide: keepalive lets the request outlive the page.
  stop: (id) =>
    fetch("/api/assistant-talk", {
      method: "DELETE",
      keepalive: true,
      headers: json,
      body: JSON.stringify({ id }),
    })
      .then(observeBuild)
      .catch(() => {}),
  /** One agent reply read aloud: MP3 bytes, or an error with a stable `code`. */
  async speech(conversationId, messageId, language, signal) {
    const path = `/api/assistant-conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/speech`;
    const response = observeBuild(
      await fetch(path, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ language }),
        signal,
      }),
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const code = typeof data.code === "string" ? data.code : "failed";
      throw Object.assign(new Error(code), { code, status: response.status });
    }
    return response.arrayBuffer();
  },
};
