import { defineRuntimeDescriptor } from "../agent-runtime.js";

/**
 * What Hermes Agent states about itself (docs/adr/0007-runtime-descriptor.md; the
 * traits are described in ../runtime-traits.js, the behaviour in
 * docs/hermes-runtime.md).
 */
export const hermesDescriptor = defineRuntimeDescriptor({
  id: "hermes",
  name: "Hermes Agent",
  // "Hermes agents", "Hermes's defaults".
  shortName: "Hermes",
  traits: {
    approvals: {
      // Hermes's "approval" asks only for dangerous commands; "every" is the
      // stricter level AgentPier's guard adds (ADR 0006 decision 5). No "review":
      // Hermes's `smart` approvals are no equivalent (docs/hermes-runtime.md).
      shellLevels: ["off", "approval", "every", "full"],
      // Hermes keeps no allowlist AgentPier may write: "Always allow" is the exact
      // command AgentPier remembers (exec-remembered.js).
      allowlist: "exactCommands",
    },
    // MEMORY.md and USER.md as separated entries with character limits; each agent
    // dreams by itself (hermes-dreams.js), not through the host's dreaming.
    agentFiles: { memoryFormat: "entries", dreaming: "agent" },
    // Only a ChatGPT login AgentPier holds reaches Hermes, through its model proxy.
    models: { chatgptLogin: "agentpierHeld" },
    // The agent's own bot reads its people at the start of the agent's processes.
    channelBots: { peopleApply: "restart" },
    // Every agent reviews its work and writes skills unless AgentPier switches the
    // review off (hermes-config/skills.js); the skills stay in the agent's own home,
    // so a user's agent may learn too, and `skill_manage` stays with learning off. An
    // agent with a bot for other people has no session_search (hermes-config/
    // telegram.js), so its review never reads those people's chats.
    skills: {
      learnsByDefault: true,
      userAgentsLearn: true,
      writesWhenAsked: true,
      channelBotsLearn: true,
    },
    // Each chat's uploads live in a folder of that chat (chat-file-folders.js).
    sessions: { chatFolders: true },
    // One process set per agent (ADR 0006 decision 4), installed by the owner.
    host: { process: "perAgent", install: "optional" },
  },
  // Agents › Runtime › Hermes Agent: the owner's switch, the install state and the
  // update. It shows before Hermes is installed; that is where it gets installed.
  surfaces: [
    { id: "install", slot: "hub.runtime", kind: "built", shows: "always" },
    // An agent's Capabilities tab › Mixture of Agents: its advisor models
    // (runtimeOptions.hermes, hermes-options.js), while Hermes may run agents.
    { id: "mixture", slot: "agent.capabilities", kind: "built" },
  ],
});
