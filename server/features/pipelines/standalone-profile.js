import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { PERMISSION_MODES, validateProfile } from "./profile-validation.js";

// Per-session choices never update the stored profile or pipeline snapshots.
export function standaloneProfile(profile, access, accounts) {
  if (access === undefined) return profile;
  if (!access || typeof access !== "object" || Array.isArray(access))
    throw problem(serverMessages.providers.invalidAccessSelection);
  if (!Object.hasOwn(PERMISSION_MODES, access.tool))
    throw problem(serverMessages.pipelineProfiles.invalidSessionCli);
  if (access.providerConnectionId !== undefined && access.nativeModelId !== undefined)
    throw problem(serverMessages.providers.nativeOrProviderModel);
  if (access.providerConnectionId === undefined && access.providerModelId !== undefined)
    throw problem(serverMessages.providers.connectionRequiredForModel);
  const config = { ...profile.config, cliTool: access.tool };
  if (access.tool !== profile.config.cliTool)
    config.permissions = {
      mode: { codex: "on-request", claude: "default", opencode: "ask" }[access.tool],
    };
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
