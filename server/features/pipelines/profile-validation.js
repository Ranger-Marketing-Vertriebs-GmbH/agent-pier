import { serverMessages } from "../../lib/i18n/de.js";
import { nameValue, problem } from "../../lib/storage.js";
import { validateProviderSelection } from "../providers/provider-definitions.js";

export const PERMISSION_MODES = Object.freeze({
  claude: [
    "default",
    "manual",
    "acceptEdits",
    "plan",
    "auto",
    "dontAsk",
    "bypassPermissions",
  ],
  codex: ["untrusted", "on-request", "never"],
  opencode: ["ask", "auto"],
});
export const PROFILE_PHASES = [
  "refinement",
  "planning",
  "implementation",
  "review",
  "maintenance",
];

export function boundedText(value, message, max, { empty = true } = {}) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    value.includes("\0") ||
    (!empty && !value.trim())
  )
    throw problem(message);
  return value;
}

export function profileConnection(config, accounts) {
  if (config.providerConnectionId === undefined) return null;
  if (!accounts.providerConnections)
    throw problem(serverMessages.pipelineProfiles.connectionsUnavailable, 409);
  const connection = accounts.providerConnections.get(config.providerConnectionId);
  if (!connection.tools.includes(config.cliTool))
    throw problem(serverMessages.pipelineProfiles.connectionUnsupported);
  for (const modelId of config.models.available)
    validateProviderSelection(
      {
        id: connection.providerId,
        modelId,
        ...(config.cliTool === "codex" && connection.providerId !== "openrouter"
          ? { responsesAccess: connection.responsesAccess }
          : {}),
      },
      config.cliTool,
      accounts.providerCatalog,
    );
  return {
    id: connection.id,
    providerId: connection.providerId,
    ...(config.cliTool === "codex" && connection.providerId !== "openrouter"
      ? { responsesAccess: connection.responsesAccess }
      : {}),
  };
}

export function validateProfile(body, accounts) {
  const name = nameValue(body?.name);
  const description = boundedText(
    body.description ?? "",
    serverMessages.pipelineProfiles.invalidProfileDescription,
    2000,
  );
  if (typeof body.enabled !== "boolean")
    throw problem(serverMessages.pipelineProfiles.enabledBoolean);
  const config = body.config;
  if (!config || !Object.hasOwn(PERMISSION_MODES, config.cliTool))
    throw problem(serverMessages.pipelineProfiles.invalidCli);
  const account = accounts.get(config.accountId);
  if (account.internal) throw problem(serverMessages.accounts.notFound, 404);
  if (account.tool !== config.cliTool || account.tool === "shell")
    throw problem(serverMessages.pipelineProfiles.accountCliMismatch);
  const available = config.models?.available;
  if (!Array.isArray(available) || available.length < 1 || available.length > 100)
    throw problem(serverMessages.pipelineProfiles.modelCount);
  const models = [
    ...new Set(
      available.map((model) =>
        boundedText(model, serverMessages.pipelineProfiles.invalidModel, 200),
      ),
    ),
  ];
  if (!models.includes(config.models.default))
    throw problem(serverMessages.pipelineProfiles.defaultModelUnavailable);
  const connection = profileConnection(config, accounts);
  const mode = config.permissions?.mode;
  if (!PERMISSION_MODES[config.cliTool].includes(mode))
    throw problem(serverMessages.pipelineProfiles.invalidPermissionMode(config.cliTool));
  if (typeof config.run?.autonomous !== "boolean")
    throw problem(serverMessages.pipelineProfiles.autonomousBoolean);
  const role = boundedText(
    config.prompts?.role ?? "",
    serverMessages.pipelineProfiles.invalidRolePrompt,
    16000,
  );
  const kickoff = boundedText(
    config.prompts?.kickoff ?? "",
    serverMessages.pipelineProfiles.invalidKickoffPrompt,
    32000,
    {
      empty: !config.run.autonomous,
    },
  );
  const rawParams = config.prompts?.params ?? [];
  if (!Array.isArray(rawParams) || rawParams.length > 30)
    throw problem(serverMessages.pipelineProfiles.parameterLimit);
  const keys = new Set();
  const params = rawParams.map((param) => {
    if (
      typeof param?.key !== "string" ||
      !/^[A-Za-z0-9_]{1,64}$/.test(param.key) ||
      keys.has(param.key) ||
      ["__proto__", "constructor", "prototype"].includes(param.key)
    )
      throw problem(serverMessages.pipelineProfiles.invalidParameter);
    keys.add(param.key);
    if (typeof param.required !== "boolean")
      throw problem(serverMessages.pipelineProfiles.parameterRequiredBoolean);
    return {
      key: param.key,
      label: boundedText(
        param.label,
        serverMessages.pipelineProfiles.invalidParameterLabel,
        100,
        { empty: false },
      ),
      required: param.required,
    };
  });
  return {
    name,
    description,
    enabled: body.enabled,
    phaseKey: PROFILE_PHASES.includes(body.phaseKey) ? body.phaseKey : null,
    config: {
      accountId: account.id,
      ...(connection ? { providerConnectionId: connection.id } : {}),
      cliTool: account.tool,
      models: { available: models, default: config.models.default },
      prompts: { role, kickoff, params },
      permissions: { mode },
      run: { autonomous: config.run.autonomous },
    },
  };
}

export function renderProfilePrompt(profile, values = {}, model) {
  const config = profile.config;
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw problem(serverMessages.pipelineProfiles.invalidParameters);
  const params = config.prompts.params;
  const keys = new Set(params.map((param) => param.key));
  for (const key of Object.keys(values)) {
    if (!keys.has(key))
      throw problem(serverMessages.pipelineProfiles.unknownParameter(key));
    boundedText(
      values[key],
      serverMessages.pipelineProfiles.invalidParameterValue,
      16000,
    );
  }
  for (const param of params)
    if (param.required && !values[param.key]?.trim())
      throw problem(serverMessages.pipelineProfiles.parameterRequired(param.label));
  if (model !== undefined && !config.models.available.includes(model))
    throw problem(serverMessages.pipelineProfiles.modelUnavailable);
  const kickoff = config.prompts.kickoff.replace(
    /\{\{([A-Za-z0-9_]+)\}\}/g,
    (match, key) => (keys.has(key) ? (values[key] ?? "") : match),
  );
  return boundedText(
    [config.prompts.role, kickoff].filter(Boolean).join("\n\n"),
    serverMessages.pipelineProfiles.invalidRenderedPrompt,
    64000,
  );
}

export function validateVerification(body) {
  if (!Array.isArray(body?.steps) || body.steps.length > 20)
    throw problem(serverMessages.pipelineProfiles.verificationStepLimit);
  let timeout = 0;
  const steps = body.steps.map((step) => {
    if (
      !Number.isInteger(step?.timeoutMs) ||
      step.timeoutMs < 1000 ||
      step.timeoutMs > 7200000
    )
      throw problem(serverMessages.pipelineProfiles.verificationTimeoutRange);
    timeout += step.timeoutMs;
    if (typeof step.blocking !== "boolean")
      throw problem(serverMessages.pipelineProfiles.verificationBlockingBoolean);
    return {
      name: boundedText(
        step.name,
        serverMessages.pipelineProfiles.invalidVerificationStepName,
        100,
        { empty: false },
      ),
      command: boundedText(
        step.command,
        serverMessages.pipelineProfiles.invalidVerificationCommand,
        8000,
        { empty: false },
      ),
      timeoutMs: step.timeoutMs,
      blocking: step.blocking,
    };
  });
  if (timeout > 7200000)
    throw problem(serverMessages.pipelineProfiles.verificationTotalTimeout);
  return steps;
}
