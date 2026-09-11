import { problem } from "../../lib/storage.js";
import { validateProfile } from "./profile-validation.js";

// Per-session choices never update the stored profile or pipeline snapshots.
export function standaloneProfile(profile, access, accounts) {
  if (access === undefined) return profile;
  if (!access || typeof access !== "object" || Array.isArray(access))
    throw problem("Invalid session access selection.");
  if (access.tool !== profile.config.cliTool)
    throw problem("The session CLI must match the task profile.");
  if (access.providerConnectionId !== undefined && access.nativeModelId !== undefined)
    throw problem("Choose either a native model or a provider model.");
  if (access.providerConnectionId === undefined && access.providerModelId !== undefined)
    throw problem("Select a provider connection for the provider model.");
  const config = { ...profile.config };
  delete config.providerConnectionId;
  config.accountId = access.accountId;
  if (access.providerConnectionId !== undefined)
    config.providerConnectionId = access.providerConnectionId;
  const model =
    access.providerConnectionId !== undefined
      ? access.providerModelId
      : (access.nativeModelId ?? "");
  config.models = { available: [model], default: model };
  return { ...profile, ...validateProfile({ ...profile, config }, accounts) };
}
