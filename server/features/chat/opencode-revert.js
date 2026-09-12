import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
const invalid = () => problem(serverMessages.chat.sessionHistoryMismatch, 409);
export function openCodeRevert(value) {
  if (!value) return null;
  let revert;
  try {
    revert = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw invalid();
  }
  if (!revert) return null;
  if (
    typeof revert.messageID !== "string" ||
    !revert.messageID ||
    (revert.partID !== undefined && (typeof revert.partID !== "string" || !revert.partID))
  )
    throw invalid();
  return revert;
}
export function activeOpenCodeExport(exported) {
  const revert = openCodeRevert(exported.info?.revert);
  if (!revert) return exported;
  const index = exported.messages?.findIndex(
    (message) => message.info?.id === revert.messageID,
  );
  if (index === undefined || index < 0) throw invalid();
  const messages = exported.messages.slice(0, index);
  if (revert.partID) {
    const target = exported.messages[index];
    const part = target.parts?.findIndex((item) => item.id === revert.partID);
    if (part === undefined || part < 0) throw invalid();
    messages.push({ ...target, parts: target.parts.slice(0, part) });
  }
  return { ...exported, messages };
}
