import api from "../../../lib/api.js";

// The owner's pinboard routes (server/http/routes/assistant-pinboard.js); the lists
// themselves come from the `agent.pinboard:<agentId>` live topic (usePinboard).
const base = (assistantId, entryId) =>
  `/assistants/${encodeURIComponent(assistantId)}/pinboard/entries/${encodeURIComponent(entryId)}`;

export const pinboardApi = {
  /** Clears the entry's NEW mark for the version the server reads now. */
  async seen(assistantId, entryId) {
    await api(`${base(assistantId, entryId)}/seen`, "POST");
  },
};

/** The pinned file's bytes (range requests for media); `download` saves it by name. */
export function pinboardFileUrl(assistantId, entryId, { download = false } = {}) {
  return `/api${base(assistantId, entryId)}/file${download ? "?download=1" : ""}`;
}
