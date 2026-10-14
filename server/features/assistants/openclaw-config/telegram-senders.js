import { personalEligible, personalShell } from "../native-capabilities.js";

// Verified against OpenClaw 2026.10.3, see docs/assistant-telegram-senders-qualification.md
// and tests/integration/assistant-telegram-senders-contract.test.js: one Telegram account
// per agent owns its bot through a binding, an allowlisted account admits only the
// listed Telegram user ids, `per-account-channel-peer` keeps a conversation per
// sender, a loopback `apiRoot` serves the Bot API in tests, and Deepgram transcribes
// voice notes with the key from `models.providers.deepgram.apiKey`.

/** Deepgram's batch endpoint; OpenClaw requires an explicit base URL for its key. */
export const deepgramBaseUrl = "https://api.deepgram.com/v1";
/**
 * Top-level paths only this layer writes. Locked against overrides: each could route
 * messages to an agent, forward approvals or let a sender run commands.
 */
export const telegramSurfaces = [
  "bindings",
  "session",
  "commands",
  "approvals",
  "accessGroups",
];

/**
 * Agents that may own a bot for other people: personal, not archived and without
 * shell. A sender must never reach host commands, whatever the store says.
 */
export function telegramEligible(profile, stdio = new Set()) {
  return (
    !!profile?.runtimeAgentId &&
    personalEligible(profile) &&
    personalShell(profile) === "off" &&
    // A stdio MCP server runs host commands as well; remote servers stay allowed.
    !stdio.has(profile.id)
  );
}

/**
 * Assistant ids bound to a stdio MCP server, from readMcpInputs' `servers` and
 * `bindings`. Such an agent never owns a bot for other people.
 */
export function stdioAgents({ servers = [], bindings = {} } = {}) {
  const stdio = new Set(servers.filter((s) => s?.transport === "stdio").map((s) => s.id));
  return new Set(
    Object.entries(bindings)
      .filter(([, ids]) => (ids || []).some((id) => stdio.has(id)))
      .map(([assistantId]) => assistantId),
  );
}

/**
 * Reads what a Gateway start compiles. Never throws: an unreadable store compiles no
 * bot, an unreadable speech key compiles text only.
 * - `accounts`: `[{ assistantId, botId, token, tokenRevision, people: [userId] }]`.
 * - `speech`: `{ apiKey, keyRevision, model, language }`, or null without a key.
 * Revisions tell a changed token or key; nothing is ever derived from the values.
 * - `apiRoot`, `deepgram`: test seams; production compiles neither.
 */
export function readTelegramInputs(store, speech, { apiRoot, deepgram } = {}) {
  const inputs = { accounts: [], speech: null, unreadable: false };
  if (apiRoot) inputs.apiRoot = apiRoot;
  if (deepgram) inputs.deepgram = deepgram;
  try {
    inputs.accounts = store?.compiled() || [];
  } catch {
    inputs.unreadable = true;
  }
  if (!inputs.accounts.length) return inputs;
  try {
    const lease = speech?.acquire();
    if (lease) {
      lease.release();
      inputs.speech = {
        apiKey: lease.apiKey,
        keyRevision: lease.keyRevision,
        model: lease.model,
        language: lease.language,
      };
    }
  } catch {
    // No key: voice notes stay untranscribed.
  }
  return inputs;
}

/**
 * The agent ids a configuration defines. OpenClaw refuses a configuration whose
 * binding names another agent, so only these agents can own a bot at a start.
 */
export function configuredAgents(config) {
  const agents = config?.agents;
  if (Array.isArray(agents?.list) && !agents?.entries)
    return new Set(agents.list.map((entry) => entry?.id).filter(Boolean));
  const entries = agents?.entries;
  if (Array.isArray(entries))
    return new Set(entries.map((entry) => entry?.id).filter(Boolean));
  return new Set(Object.entries(entries || {}).map(([key, entry]) => entry?.id || key));
}

/**
 * The Gateway sections the agents' own bots need. Pure; empty (no accounts) when no
 * eligible agent has a bot with at least one allowed person. `agents`, when given,
 * are the agent ids the Gateway knows (configuredAgents); a bot of any other agent
 * waits for the next start after the agent's first apply.
 * - `accounts`: `channels.telegram.accounts`, keyed by the agent's runtime id.
 * - `bindings`: top-level bindings, one per account.
 * - `voice`: the Deepgram settings, or null (text only).
 * - `skipped`: assistant ids of stored bots that are not compiled.
 */
export function telegramSections({ profiles = [], telegram, agents, stdio } = {}) {
  const sections = {
    accounts: {},
    bindings: [],
    voice: null,
    // Secret-free: each account's token revision and the speech key's revision.
    revisions: { tokens: {}, key: null },
    apiRoot: telegram?.apiRoot || null,
    deepgram: telegram?.deepgram || null,
    skipped: [],
  };
  const byId = new Map(profiles.map((p) => [p.id, p]));
  for (const stored of telegram?.accounts || []) {
    const profile = byId.get(stored.assistantId);
    const people = [...new Set(stored.people || [])].filter((id) =>
      /^\d{1,20}$/.test(id),
    );
    // An allowlist without ids is rejected by OpenClaw's validation.
    if (
      !telegramEligible(profile, stdio) ||
      !people.length ||
      !stored.token ||
      (agents && !agents.has(profile.runtimeAgentId))
    ) {
      sections.skipped.push(String(stored.assistantId));
      continue;
    }
    const accountId = profile.runtimeAgentId;
    sections.accounts[accountId] = {
      enabled: true,
      botToken: stored.token,
      dmPolicy: "allowlist",
      allowFrom: people,
      groupPolicy: "disabled",
      configWrites: false,
      execApprovals: { enabled: false },
    };
    sections.revisions.tokens[accountId] = stored.tokenRevision ?? null;
    sections.bindings.push({
      agentId: accountId,
      match: { channel: "telegram", accountId },
    });
  }
  sections.skipped.sort();
  if (sections.bindings.length && telegram?.speech?.apiKey) {
    const { apiKey, model, language, keyRevision } = telegram.speech;
    sections.voice = { apiKey, model: model || "nova-3", language };
    sections.revisions.key = keyRevision ?? null;
  }
  return sections;
}

/** Removes every surface this layer owns; the next apply writes them afresh. */
function resetTelegram(config) {
  for (const key of telegramSurfaces) delete config[key];
  if (config.models?.providers) delete config.models.providers.deepgram;
}

/**
 * Applies telegramSections to a compiled configuration whose `channels` and `tools`
 * the compiler has reset. Only a configuration with a plugin allow list (the native
 * team start) gets accounts; any other is only cleared.
 */
export function applyTelegram(config, sections) {
  resetTelegram(config);
  if (!sections.bindings.length || !Array.isArray(config.plugins?.allow)) return config;
  config.channels = {
    ...config.channels,
    telegram: {
      enabled: true,
      // Nothing reaches an agent unless its own account admits the sender.
      dmPolicy: "disabled",
      groupPolicy: "disabled",
      configWrites: false,
      defaultAccount: sections.bindings[0].agentId,
      ...(sections.apiRoot && { apiRoot: sections.apiRoot }),
      accounts: sections.accounts,
    },
  };
  config.bindings = sections.bindings;
  // A conversation per sender and bot; never the agent's main session.
  config.session = { dmScope: "per-account-channel-peer" };
  // Senders are no operators: no menu, no directives, no admin commands.
  config.commands = {
    native: false,
    nativeSkills: false,
    bash: false,
    config: false,
    mcp: false,
    plugins: false,
    debug: false,
    restart: false,
    allowFrom: { telegram: [] },
  };
  config.tools.agentToAgent = { enabled: false };
  config.plugins.allow = [...config.plugins.allow, "telegram"];
  if (!sections.voice) {
    // No local transcription fallback on the owner's machine either.
    config.tools.media = { audio: { enabled: false } };
    return config;
  }
  const { apiKey, model, language } = sections.voice;
  config.tools.media = {
    models: [
      {
        provider: "deepgram",
        model,
        ...(language && language !== "auto" && { language }),
        capabilities: ["audio"],
      },
    ],
    audio: { enabled: true },
  };
  config.plugins.allow.push("deepgram");
  config.models = {
    ...config.models,
    providers: {
      ...config.models?.providers,
      deepgram: {
        apiKey,
        baseUrl: sections.deepgram?.baseUrl || deepgramBaseUrl,
        ...(sections.deepgram?.baseUrl && { request: { allowPrivateNetwork: true } }),
        models: [],
      },
    },
  };
  return config;
}

/**
 * What a start compiles, without any token or key: account settings with the
 * token's revision in place of the token, and the voice settings with the key's
 * revision. Equal strings mean the same compiled Telegram sections.
 */
export function telegramSignature(sections) {
  const { bindings, voice, apiRoot, deepgram, revisions } = sections;
  const accounts = Object.fromEntries(
    Object.entries(sections.accounts).map(([id, { botToken: _token, ...account }]) => [
      id,
      { ...account, tokenRevision: revisions.tokens[id] },
    ]),
  );
  return JSON.stringify({
    accounts,
    bindings,
    voice: voice && { model: voice.model, language: voice.language, key: revisions.key },
    apiRoot,
    deepgram,
  });
}

/**
 * What the supervisor keeps about a Gateway start: the compiled account ids, their
 * allowed people and token revisions, whether voice notes are transcribed (and the
 * key's revision) and the signature. Never a token or key, nor anything derived.
 */
export function telegramSnapshot(sections) {
  const accounts = Object.keys(sections.accounts);
  return {
    accounts,
    people: Object.fromEntries(
      accounts.map((id) => [id, [...sections.accounts[id].allowFrom]]),
    ),
    tokens: Object.fromEntries(accounts.map((id) => [id, sections.revisions.tokens[id]])),
    voice: !!sections.voice,
    voiceKey: sections.voice ? sections.revisions.key : null,
    signature: telegramSignature(sections),
  };
}

/**
 * Whether `desired` takes away something the Gateway started with (`running`): a
 * bot, an allowed person, a token or the speech key. Such a change must reach the
 * Gateway without waiting for an unrelated restart.
 */
export function telegramRevoked(running, desired) {
  if (!running) return false;
  for (const id of running.accounts) {
    if (!desired.accounts.includes(id)) return true;
    if (running.tokens[id] !== desired.tokens[id]) return true;
    if (running.people[id].some((person) => !desired.people[id].includes(person)))
      return true;
  }
  return running.voice && running.voiceKey !== desired.voiceKey;
}
