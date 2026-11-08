import {
  browserVisible,
  inheritsFromLead,
  memoryEnabled,
  personalCapabilities,
  personalEligible,
  personalShell,
  personalSkills,
  releasedCapabilities,
  toolGrants,
  webCapabilityKeys,
} from "./native-capabilities.js";
import { compiledSkillNames } from "./built-in-skills.js";
import { agentProfileName } from "./browser-profile-names.js";
import { isShared, isUserAgent } from "../users/user-access.js";
import { mcpEligible } from "../mcp-servers/mcp-inputs.js";
import { stdioAgents, telegramEligible } from "../assistant-channels/telegram-inputs.js";

// AgentPier's runtime-neutral desired state (docs/adr/0006-assistant-runtime-port.md,
// decision 3): what each agent should be, read from AgentPier's own stores and
// interpreted by AgentPier's own rules (native-capabilities.js and the modules it
// names), never in a runtime's terms. Each runtime adapter compiles it into its own
// configuration through the config sub-port (runtimes/agent-runtime.js documents
// the shape). Built only here, so an adapter can tell it from anything else.
const built = new WeakSet();
const frozen = (value) => {
  for (const inner of Object.values(value))
    if (inner && typeof inner === "object" && !Object.isFrozen(inner)) frozen(inner);
  return Object.freeze(value);
};

/** Whether `value` is an agent's desired state (desiredAgent). */
export const isDesiredAgent = (value) => built.has(value);
/** Whether `value` is a whole desired state (desiredState). */
export const isDesiredState = (value) => built.has(value) && Array.isArray(value.agents);

/**
 * One agent's desired state from its stored record `profile` and what other stores
 * hold about it: `ssh` (it holds an SSH grant), `shellPath` (folders its shell PATH
 * starts with: its GitHub folder, its SSH agent's bin/), `mcp` (ids of the MCP
 * servers bound to it), `stdio` (one of them runs a local command), `instructions`
 * (its managed AGENTS.md) and `model` (its model connection: `{ ref, providerId,
 * provider, agentRuntime }`), the last two only for a live apply; `channelBot`, for
 * a runtime that runs the agent's own Telegram bot in the agent's own process set
 * (Hermes): `{ token, people, speech, apiRoot, deepgram }` as telegram-senders-own.js
 * reads it, null for none, left out when unknown; `lead`, a temporary member's lead's
 * record, whose window setting its borrowed browser follows. Deeply frozen.
 */
export function desiredAgent(
  profile,
  {
    ssh = false,
    shellPath = [],
    mcp = [],
    stdio = false,
    instructions,
    model,
    channelBot,
    lead = null,
  } = {},
) {
  const capabilities = personalCapabilities(profile);
  const released = releasedCapabilities(profile);
  const eligible = personalEligible(profile);
  const inherits = inheritsFromLead(profile);
  const agent = frozen({
    id: profile.id,
    runtimeAgentId: profile.runtimeAgentId,
    name: profile.name,
    archived: !!profile.archivedAt,
    // Its own settings apply (an own agent or a permanent member).
    eligible,
    // A temporary member running on what its lead granted it.
    inherits,
    // A user agent under the hard lock (user-agent-lock.js).
    locked: isUserAgent(profile),
    // Shared with users: each chat is private to its person (attachment-access.js).
    shared: isShared(profile),
    team: {
      memberOf: profile.teamMemberId ?? null,
      permanent: profile.lifetime === "permanent",
    },
    // The tools it may hold, each grant with what it needs of the runtime.
    tools: toolGrants(profile, { ssh: !!ssh }),
    shell: { level: personalShell(profile), pathPrepend: [...shellPath] },
    memory: memoryEnabled(profile),
    skills: { assigned: personalSkills(profile), compiled: compiledSkillNames(profile) },
    mcp: { eligible: mcpEligible(profile), servers: [...new Set(mcp)] },
    web: Object.fromEntries(
      webCapabilityKeys.map((key) => [key, capabilities[key] || released.includes(key)]),
    ),
    browser: {
      // Its own setting, or one its user may switch herself (released).
      wanted:
        eligible && !inherits && (capabilities.browser || released.includes("browser")),
      // A temporary member's browser its lead granted: OpenClaw lends it a member
      // slot at run time (agent-browsers.js), a runtime of its own process set
      // (Hermes) gives it a browser of its own for the member's lifetime.
      borrowed: inherits && capabilities.browser === true,
      // A borrowed browser shows a window as its lead's would (`lead`).
      visible: inherits ? browserVisible(lead) : browserVisible(profile),
      profile: agentProfileName(profile.id),
    },
    channels: {
      telegram: {
        // It may own a bot for other people: no shell, local MCP command or SSH.
        eligible: telegramEligible(
          profile,
          new Set(stdio ? [profile.id] : []),
          new Set(ssh ? [profile.id] : []),
        ),
      },
    },
    ssh: !!ssh,
  });
  // The model connection's provider stays the caller's object: frozen only here.
  const desired = Object.freeze({
    ...agent,
    ...(instructions !== undefined && { instructions }),
    ...(model && { model: Object.freeze({ ...model }) }),
    ...(channelBot !== undefined && {
      channelBot: channelBot && frozen(structuredClone(channelBot)),
    }),
  });
  built.add(desired);
  return desired;
}

/**
 * The desired state of every agent and of the host, from what a Gateway start (or a
 * live apply) reads from the stores. Every field is optional:
 * - `profiles`: the agents' records; `sshAgents`: ids with an SSH grant;
 *   `githubShell`, `sshShell`: `{ [id]: folders }` on an agent's shell PATH.
 * - `mcp`: the MCP store's servers, bindings and secrets (mcp-inputs.js
 *   readMcpInputs); `stdio`: ids bound to a local command server, else from `mcp`.
 * - `telegram`: the agents' bots and the speech key (telegram-inputs.js).
 * - `webTools`: the web search, browser, image, PDF settings and what the runtime
 *   bundles for them; `dreaming`: the owner's dreaming setting.
 * - `directory`, `connection`: the team plugin and its bridge; `native`: the native
 *   tools' webhook; `hostMaxConcurrent`: the host's member slots.
 * Returns `{ agents, host }`, frozen; host inputs are the stores' own objects.
 */
export function desiredState(inputs = {}) {
  const {
    profiles = [],
    sshAgents,
    githubShell,
    sshShell,
    mcp,
    stdio = stdioAgents(mcp || {}),
    telegram,
    webTools,
    dreaming,
    directory,
    connection,
    native,
    hostMaxConcurrent,
  } = inputs;
  const bindings = mcp?.bindings || {};
  const agents = profiles.map((profile) =>
    desiredAgent(profile, {
      ssh: !!sshAgents?.has(profile.id),
      shellPath: [
        ...(githubShell?.[profile.id] || []),
        ...(sshShell?.[profile.id] || []),
      ],
      mcp: bindings[profile.id] || [],
      stdio: stdio.has(profile.id),
      lead: profile.parentAssistantId
        ? profiles.find((p) => p.id === profile.parentAssistantId) || null
        : null,
    }),
  );
  const { bindings: _bindings, ...servers } = mcp || {};
  const state = Object.freeze({
    agents: Object.freeze(agents),
    host: Object.freeze({
      team: Object.freeze({
        plugin: directory && connection ? Object.freeze({ directory, connection }) : null,
        native: native || null,
        maxConcurrent: hostMaxConcurrent,
      }),
      dreaming: dreaming || {},
      webTools,
      mcp: mcp ? servers : undefined,
      telegram,
    }),
  });
  built.add(state);
  return state;
}
