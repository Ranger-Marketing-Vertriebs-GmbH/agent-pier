import { problem as failure } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { validId, validName } from "./session-validation.js";
import { privateWrite } from "./session-process-runtime.js";
import { checkedAdapter } from "../adapter-runtime/adapter-config.js";
import { publicProviderConfiguration } from "./provider-configuration.js";
import { pipelineIdentity, nativeInput } from "../pipelines/native-session.js";
import { randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** The secrets binding a session keeps (session-secrets.js): ids only, never values. */
function sessionSecretsRecord({ projectId, assignedIds }) {
  if (
    (projectId !== null && (typeof projectId !== "string" || projectId.length > 120)) ||
    !Array.isArray(assignedIds) ||
    assignedIds.length > 50 ||
    assignedIds.some((id) => typeof id !== "string" || id.length > 100)
  )
    throw failure(serverMessages.sessions.invalidOptions);
  return { projectId, assignedIds: [...assignedIds] };
}

/** Who started a session on its own: only the server sets it (agents, AGENTPIER-225). */
function startedByRecord(value) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    value.kind !== "agent" ||
    typeof value.assistantId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value.assistantId) ||
    typeof value.name !== "string" ||
    value.name.length > 100
  )
    throw failure(serverMessages.sessions.invalidOptions);
  return { kind: "agent", assistantId: value.assistantId, name: value.name };
}

/**
 * Validates a session creation request, then persists the launch description the
 * spawned process reads (`${id}.launch.json`, the `terminal-launcher.js` boundary)
 * and the public session record (`${id}.json`). Owns none of the tmux/process
 * control that follows a successful write; that stays with `SessionManager.create`.
 */
export async function buildSessionLaunch(manager, options) {
  if (!options || typeof options !== "object")
    throw failure(serverMessages.sessions.invalidOptions);
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
  const startedBy = startedByRecord(options.startedBy);
  const name = validName(options.name);
  if (!["codex", "claude", "opencode", "shell"].includes(tool))
    throw failure(serverMessages.sessions.invalidTool);
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
    throw failure(serverMessages.sessions.invalidWorkingDirectory);
  if (
    typeof command !== "string" ||
    !path.isAbsolute(command) ||
    command.includes("\0") ||
    !(await stat(command).then(
      (info) => info.isFile(),
      () => false,
    ))
  )
    throw failure(serverMessages.sessions.invalidExecutable);
  await access(command, constants.X_OK).catch(() => {
    throw failure(serverMessages.sessions.invalidExecutable);
  });
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    args.join("").length > 1024 * 1024
  )
    throw failure(serverMessages.sessions.invalidArguments);
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
    throw failure(serverMessages.sessions.invalidEnvironment);
  try {
    await access(manager.file(id));
    throw failure(serverMessages.sessions.alreadyExists, 409);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const adapter = options.adapter
    ? checkedAdapter(options.adapter, manager.directory, id, () =>
        failure(serverMessages.sessions.invalidAdapterConfiguration),
      )
    : null;
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
      ...(adapter ? { adapter } : {}),
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
    // Only this launch's adapter may write `<id>.adapter.json` (adapter-diagnostics.js).
    ...(adapter ? { adapterGeneration: adapter.generation } : {}),
    ...(pipeline ? { pipeline } : {}),
    ...(startedBy ? { startedBy } : {}),
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
  // The CLI release the session started with, for diagnosing parser or flag changes.
  if (typeof options.cliVersion === "string") session.cliVersion = options.cliVersion;
  // A task profile's effective permission arguments; a reload reuses exactly these.
  if (options.permissionArgs?.length) {
    if (
      !Array.isArray(options.permissionArgs) ||
      options.permissionArgs.length > 8 ||
      options.permissionArgs.some(
        (arg) => typeof arg !== "string" || arg.length > 300 || /[\x00-\x1f]/.test(arg),
      )
    )
      throw failure(serverMessages.sessions.invalidOptions);
    session.permissionArgs = [...options.permissionArgs];
  }
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
  if (options.secrets && options.purpose !== "login" && !pipeline?.headless)
    session.secrets = sessionSecretsRecord(options.secrets);
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
