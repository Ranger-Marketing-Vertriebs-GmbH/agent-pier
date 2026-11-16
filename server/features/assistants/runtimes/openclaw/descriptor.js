import { defineRuntimeDescriptor } from "../agent-runtime.js";

/**
 * What OpenClaw states about itself (docs/adr/0007-runtime-descriptor.md). Every
 * trait is the schema's default (../runtime-traits.js): the defaults are OpenClaw's
 * behaviour, the runtime every agent ran on before agents named theirs.
 */
export const openClawDescriptor = defineRuntimeDescriptor({
  id: "openclaw",
  name: "OpenClaw",
});
