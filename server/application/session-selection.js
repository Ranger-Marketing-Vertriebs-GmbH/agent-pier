import { serverMessages } from "../lib/i18n/de.js";
import { problem } from "../lib/storage.js";
export function nativeModelFor(body, account, { login = false } = {}) {
  const model = body.nativeModelId;
  if (model === undefined) return undefined;
  if (login || account.tool === "shell" || account.provider || body.providerConnectionId)
    throw problem(serverMessages.sessions.nativeModelNativeOnly);
  if (
    typeof model !== "string" ||
    !model ||
    model.length > 200 ||
    /[\s\x00-\x1f\x7f]/.test(model)
  )
    throw problem(serverMessages.sessions.invalidNativeModel);
  return model;
}
