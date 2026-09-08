import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { problem } from "../../lib/storage.js";
import { nativeCommand } from "./native-command.js";
import { profileConnection } from "./profile-validation.js";

export function accountConfiguration(account) {
  return {
    id: account.id,
    tool: account.tool,
    kind: account.kind,
    ...(account.provider ? { provider: account.provider } : {}),
  };
}
export function validateFrozenAccount(profile, account) {
  if (
    account.id !== profile.config.accountId ||
    account.tool !== profile.config.cliTool ||
    (profile.accountSnapshot &&
      !isDeepStrictEqual(accountConfiguration(account), profile.accountSnapshot))
  )
    throw problem(
      "The profile account configuration changed. Start a new run with the updated profile.",
      409,
    );
}
export function profileAccess(profile, modelId = profile.config.models.default) {
  return {
    accountId: profile.config.accountId,
    ...(profile.config.providerConnectionId !== undefined
      ? {
          providerConnectionId: profile.config.providerConnectionId,
          providerModelId: modelId,
        }
      : {}),
  };
}
export function validateProfileLaunch(
  profile,
  account,
  accounts,
  modelId = profile.config.models.default,
) {
  if (profile.config.providerConnectionId === undefined)
    return validateFrozenAccount(profile, account);
  validateFrozenAccount(profile, accounts.get(profile.config.accountId));
  const connection = profileConnection(
    { ...profile.config, models: { available: [modelId] } },
    accounts,
  );
  if (
    (profile.providerConnectionSnapshot &&
      !isDeepStrictEqual(connection, profile.providerConnectionSnapshot)) ||
    account.internal?.kind !== "provider-connection" ||
    account.internal.sourceAccountId !== profile.config.accountId ||
    account.internal.connectionId !== connection.id ||
    account.tool !== profile.config.cliTool ||
    account.provider?.id !== connection.providerId ||
    account.provider?.modelId !== modelId
  )
    throw problem(
      "The profile provider configuration changed. Start a new run with the updated profile.",
      409,
    );
}
const helpCache = new Map();
function claudeDefaultMode(command) {
  if (!helpCache.has(command)) {
    const help = spawnSync(command, ["--help"], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 128 * 1024,
      env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    });
    if (help.status !== 0)
      throw problem("Unable to verify the native Claude permission mode.", 409);
    const permission = help.stdout.slice(
      help.stdout.indexOf("--permission-mode"),
      help.stdout.indexOf("--permission-mode") + 700,
    );
    const mode = /"manual"/.test(permission)
      ? "manual"
      : /"default"/.test(permission)
        ? "default"
        : null;
    if (!mode)
      throw problem(
        "This Claude version does not advertise the profile permission mode.",
        409,
      );
    helpCache.set(command, mode);
  }
  return helpCache.get(command);
}
export function profileCommand({
  profile,
  launch,
  sessionId,
  resumeNativeId,
  headless,
  prompt,
}) {
  const tool = profile.config.cliTool,
    mode = profile.config.permissions.mode;
  const result = nativeCommand({
    tool,
    launch,
    sessionId,
    resumeNativeId,
    headless,
    mode,
    ...(tool === "claude" && mode === "default"
      ? { claudeDefault: claudeDefaultMode(launch.command) }
      : {}),
  });
  if (headless) return { ...result, initialInput: prompt, nativeObservation: true };
  if (prompt)
    result.args.push(...(tool === "opencode" ? ["--prompt", prompt] : ["--", prompt]));
  return result;
}
