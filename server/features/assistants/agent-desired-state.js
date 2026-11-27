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
import { learnsSkills } from "./skill-learning.js";
import { runtimeIdOf } from "./runtimes/runtime-descriptors.js";
import { memberOptionsOf, runtimeOptionsOf } from "./runtimes/runtime-options.js";
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
 * provider, agentRuntime, kind }`, `kind` the connection's, "endpoint" for the
 * owner's own endpoint), the last two only for a live apply; `channelBot`, for
 * a runtime that runs the agent's own Telegram bot in the agent's own process set
 * (Hermes): `{ token, people, speech, apiRoot, deepgram }` as telegram-senders-own.js
 * reads it, null for none, left out when unknown; `lead`, a temporary member's lead's
 * record, whose window setting its borrowed browser and whose model options it
 * follows; `craft`, Craft Anything
 * rebuilds are available (native-capabilities.js toolGrants); `optionConnections`, for
 * a live apply, the model connections its runtime options name as the apply resolved
 * them (`[{ connectionId, modelId, ref, providerId, provider, display }]`, or `{
 * connectionId, modelId, unavailable }` for one it could not resolve), left out when
 * unknown. Deeply frozen.
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
    craft = false,
    optionConnections,
  } = {},
) {
  const capabilities = personalCapabilities(profile);
  const released = releasedCapabilities(profile);
  const eligible = personalEligible(profile);
  const inherits = inheritsFromLead(profile);
  const agent = frozen({
    id: profile.id,
    runtimeAgentId: profile.runtimeAgentId,
    // The runtime it runs on (a team member's read carries its lead's).
    runtime: runtimeIdOf(profile),
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
    tools: toolGrants(profile, { ssh: !!ssh, craft: !!craft }),
    shell: { level: personalShell(profile), pathPrepend: [...shellPath] },
    memory: memoryEnabled(profile),
    skills: {
      assigned: personalSkills(profile),
      compiled: compiledSkillNames(profile),
      // "Learns its own skills" (skill-learning.js); a task member follows its lead.
      learning: learnsSkills(inherits && lead ? lead : profile),
    },
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
    // Its options for the runtime it runs on (runtimes/runtime-options.js); another
    // runtime's stored options never reach a compiler. A temporary member takes over
    // what its runtime names of its lead's (how the model works).
    runtimeOptions: inherits ? memberOptionsOf(profile, lead) : runtimeOptionsOf(profile),
  });
  // The model connection's provider stays the caller's object: frozen only here.
  const desired = Object.freeze({
    ...agent,
    ...(instructions !== undefined && { instructions }),
    ...(model && { model: Object.freeze({ ...model }) }),
    ...(optionConnections && {
      optionConnections: Object.freeze(
        optionConnections.map((entry) => Object.freeze({ ...entry })),
      ),
    }),
    ...(channelBot !== undefined && {
      channelBot: channelBot && frozen(structuredClone(channelBot)),
    }),
  });
  built.add(desired);
  return desired;
}

/** The record of `profile`'s lead among `profiles`, or null (no member, unknown). */
export const leadOf = (profiles, profile) =>
  (profile.parentAssistantId &&
    profiles.find((p) => p.id === profile.parentAssistantId)) ||
  null;

/**
 * The desired state of every agent and of the host, from what a Gateway start (or a
 * live apply) reads from the stores. Every field is optional:
 * - `profiles`: the agents' records; `sshAgents`: ids with an SSH grant;
 *   `githubShell`, `sshShell`: `{ [id]: folders }` on an agent's shell PATH;
 *   `craft`: Craft Anything rebuilds are available.
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
    craft = false,
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
      craft,
      shellPath: [
        ...(githubShell?.[profile.id] || []),
        ...(sshShell?.[profile.id] || []),
      ],
      mcp: bindings[profile.id] || [],
      stdio: stdio.has(profile.id),
      lead: leadOf(profiles, profile),
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

/**
 * The desired state `state` with what local memory embeddings need on its host
 * (`semanticMemory`: SemanticMemory.compiled(), the plugin, the server and the model
 * of the owner's semantic memory search), or `state` itself without it: memory
 * search is then by keyword, the default. The stores' reads (desiredState's inputs)
 * are built into a state first. Frozen like `state`.
 */
export function withSemanticMemory(inputs, semanticMemory) {
  if (!semanticMemory) return inputs;
  const state = isDesiredState(inputs) ? inputs : desiredState(inputs || {});
  const next = Object.freeze({
    ...state,
    host: Object.freeze({ ...state.host, semanticMemory: frozen({ ...semanticMemory }) }),
  });
  built.add(next);
  return next;
}
