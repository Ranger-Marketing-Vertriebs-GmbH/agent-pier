import { problem } from "../lib/storage.js";
export function nativeModelFor(body, account, { login = false } = {}) {
  const model = body.nativeModelId;
  if (model === undefined) return undefined;
  if (login || account.tool === "shell" || account.provider || body.providerConnectionId)
    throw problem("A native model can only be selected for a native coding session.");
  if (
    typeof model !== "string" ||
    !model ||
    model.length > 200 ||
    /[\s\x00-\x1f\x7f]/.test(model)
  )
    throw problem(
      "The native model must be an exact model identifier of up to 200 characters.",
    );
  return model;
}
