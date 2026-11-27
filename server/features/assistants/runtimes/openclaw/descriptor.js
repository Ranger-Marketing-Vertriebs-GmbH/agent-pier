import { defineRuntimeDescriptor } from "../agent-runtime.js";

/**
 * What OpenClaw states about itself (docs/adr/0007-runtime-descriptor.md). Every
 * trait is the schema's default (../runtime-traits.js): the defaults are OpenClaw's
 * behaviour, the runtime every agent ran on before agents named theirs.
 */
export const openClawDescriptor = defineRuntimeDescriptor({
  id: "openclaw",
  name: "OpenClaw",
  surfaces: [
    // An agent's Identity tab › Model behaviour: its thinking level, fast mode and
    // loop protection (runtimeOptions.openclaw, openclaw-options.js).
    { id: "modelOptions", slot: "agent.identity", kind: "built" },
    // An agent's Capabilities tab › Memory wiki: the switch (runtimeOptions.openclaw,
    // openclaw-options.js) and a link to the agent's wiki while it is on.
    { id: "memoryWiki", slot: "agent.capabilities", kind: "built" },
    // The agent's wiki, read only: its pages and one page (agentFiles.wikiPages).
    { id: "wiki", slot: "agent.page", kind: "built" },
  ],
});
