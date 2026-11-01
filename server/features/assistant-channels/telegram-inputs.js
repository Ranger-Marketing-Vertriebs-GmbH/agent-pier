import { personalEligible, personalShell } from "../assistants/native-capabilities.js";
import { isUserAgent } from "../users/user-access.js";

// The agents' own Telegram bots in AgentPier's terms, runtime-neutral: which agents
// may own a bot for other people and what a start reads from the bot store and the
// speech connection. The OpenClaw adapter compiles them into channel accounts and
// bindings (runtimes/openclaw/openclaw-config/telegram-senders.js).

/**
 * Agents that may own a bot for other people: personal, not archived, not a
 * restricted user's agent, without shell, stdio MCP servers or SSH grants. A sender
 * must never reach host commands or a user's agent, whatever the store says.
 */
export function telegramEligible(profile, stdio = new Set(), ssh = new Set()) {
  return (
    !!profile?.runtimeAgentId &&
    personalEligible(profile) &&
    !isUserAgent(profile) &&
    personalShell(profile) === "off" &&
    // A stdio MCP server runs host commands as well; remote servers stay allowed.
    !stdio.has(profile.id) &&
    // So does agentpier_ssh on the hosts the owner granted (assistant-access.js).
    !ssh.has(profile.id)
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
