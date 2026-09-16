import { problem as failure } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { validId, validName } from "./session-validation.js";
import { privateWrite } from "./session-process-runtime.js";
import { publicProviderConfiguration } from "./provider-configuration.js";
import { pipelineIdentity, nativeInput } from "../pipelines/native-session.js";
import { randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/**
 * Validates a session creation request, then persists the launch description the
 * spawned process reads (`${id}.launch.json`, the `terminal-launcher.js` boundary)
 * and the public session record (`${id}.json`). Owns none of the tmux/process
 * control that follows a successful write; that stays with `SessionManager.create`.
 */
export async function buildSessionLaunch(manager, options) {
  if (!options || typeof options !== "object") throw failure("Invalid session options");
  const {
    id = randomUUID(),
    tool,
    accountId,
    cwd,
    command,
    args = [],
    env = {},
  } = options;
  validId(id);
  validId(accountId);
  const pipeline = pipelineIdentity(options.pipeline);
  const input = nativeInput(options);
  const name = validName(options.name);
  if (!["codex", "claude", "opencode", "shell"].includes(tool))
    throw failure("Invalid session tool");
  if (
    tool === "shell" &&
    (accountId !== "local-shell" ||
      options.purpose === "login" ||
      options.agentbus?.enabled ||
      (options.launchMode && options.launchMode !== "default"))
  )
    throw failure(serverMessages.sessions.shellConfigurationRestricted);
  if (
    typeof cwd !== "string" ||
    !path.isAbsolute(cwd) ||
    cwd.includes("\0") ||
    !(await stat(cwd).then(
      (info) => info.isDirectory(),
      () => false,
    ))
  )
    throw failure("Invalid working directory");
  if (
    typeof command !== "string" ||
    !path.isAbsolute(command) ||
    command.includes("\0") ||
    !(await stat(command).then(
      (info) => info.isFile(),
      () => false,
    ))
  )
    throw failure("Invalid executable");
  await access(command, constants.X_OK).catch(() => {
    throw failure("Invalid executable");
  });
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    args.join("").length > 1024 * 1024
  )
    throw failure("Invalid command arguments");
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    Object.entries(env).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        typeof value !== "string" ||
        value.includes("\0"),
    )
  )
    throw failure("Invalid environment");
  try {
    await access(manager.file(id));
    throw failure("Session already exists", 409);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const launchFile = path.join(manager.directory, `${id}.launch.json`);
  await privateWrite(
    manager.directory,
    `${id}.launch.json`,
    JSON.stringify({
      command,
      args,
      cwd,
      env: { TERM: "xterm-256color", ...env },
      ...input,
      ...(options.nativeObservation
        ? {
            observationPath: path.join(manager.directory, `${id}.events.jsonl`),
            outcomePath: path.join(manager.directory, `${id}.outcome.json`),
          }
        : {}),
    }),
  );
  const session = {
    id,
    name,
    tool,
    accountId,
    cwd,
    status: "running",
    createdAt: new Date().toISOString(),
    ...(pipeline ? { pipeline } : {}),
    ...(options.launchMode ? { launchMode: options.launchMode } : {}),
    ...(options.purpose === "login" ? { purpose: "login" } : {}),
    ...(options.agentbus
      ? {
          agentbus: {
            enabled: options.agentbus.enabled === true,
            ...(options.agentbus.enabled
              ? {
                  projectId: options.agentbus.projectId,
                  version: options.agentbus.version,
                }
              : {}),
          },
        }
      : {}),
    ...(options.sandbox?.profile
      ? { sandbox: { profile: options.sandbox.profile } }
      : {}),
  };
  if (options.nativeModelId) session.nativeModelId = options.nativeModelId;
  if (
    options.agentpierTools &&
    !pipeline &&
    tool !== "shell" &&
    options.purpose !== "login"
  )
    session.agentpierTools = options.agentpierTools;
  if (options.sshTools)
    session.sshTools = {
      ...options.sshTools,
      enabled: options.sshTools.enabled === true,
    };
  const eligible = tool !== "shell" && options.purpose !== "login";
  if (options.access && eligible)
    session.access = Object.fromEntries(
      [
        "providerConnectionId",
        "providerConnectionName",
        "providerId",
        "providerModelId",
        "sourceAccountId",
      ]
        .filter((key) => typeof options.access[key] === "string")
        .map((key) => [key, options.access[key]]),
    );
  if (options.memory?.enabled && eligible)
    session.memory = { enabled: true, projectId: options.memory.projectId };
  if (options.provider && eligible)
    session.provider = publicProviderConfiguration(options.provider);
  if (options.nativeBinding && eligible)
    session.nativeBinding = {
      enabled: options.nativeBinding.enabled === true,
      version: 1,
    };
  if (options.nativeRequests?.enabled && eligible && !pipeline?.headless)
    session.nativeRequests = { enabled: true, version: 1 };
  const dir =
    eligible && !pipeline?.headless ? options.attachments?.directory : undefined;
  if (typeof dir === "string" && path.isAbsolute(dir) && !dir.includes("\0"))
    session.attachments = { directory: dir };
  await manager.save(session);
  return { id, launchFile, session };
}
