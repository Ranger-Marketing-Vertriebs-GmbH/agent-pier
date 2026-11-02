import { assistantProblem } from "./assistant-validation.js";
import { familyChanged } from "./model-family.js";

/**
 * What switching an agent to `{connectionId, modelId}` would mean: whether the model
 * family changes (against the model it runs on now, a temporary member's lead's model
 * included) and so whether fresh chats are the default.
 */
export function modelSwitchPreview(assistants, id, query = {}) {
  const { connectionId, modelId } = query;
  const text = (v) => typeof v === "string" && v.length > 0 && v.length <= 256;
  if (!text(connectionId) || !text(modelId)) throw assistantProblem("invalid");
  const { connections } = assistants.models;
  if (!connectionId.startsWith("openclaw:")) {
    try {
      connections.get(connectionId);
    } catch {
      throw assistantProblem("invalid");
    }
  }
  const current = assistants.store.getAssistant(id).model;
  const changed = familyChanged(current, { connectionId, modelId }, connections);
  return { familyChanged: changed, freshChatsDefault: changed };
}
