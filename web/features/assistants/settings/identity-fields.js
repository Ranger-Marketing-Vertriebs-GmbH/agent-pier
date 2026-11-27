import { sameValue } from "../../../lib/settings/draft-state.js";
import { profileKeys, profilePatch, profileServer } from "./agent-settings-fields.js";

// The Identity tab's draft (docs/settings-pattern.md): the profile, and the agent's
// options for its runtime, which that runtime's surfaces of the slot `agent.identity`
// edit below the model (server runtimes/runtime-options.js). The Capabilities tab's
// draft holds the same options for the slot `agent.capabilities`; each tab sends the
// whole set, and the revision of the PATCH refuses a stale one.

// The runtime an agent runs on, as its view names it.
const runtimeOf = (assistant) => assistant?.runtimeInfo?.id ?? assistant?.runtime;
const savedOptions = (assistant) =>
  assistant?.runtimeOptions?.[runtimeOf(assistant)] ?? {};

export const identityKeys = [...profileKeys, "runtimeOptions"];

export const identityServer = (assistant) => ({
  ...profileServer(assistant),
  runtimeOptions: savedOptions(assistant),
});

/**
 * The Identity tab's PATCH for the saved `assistant`: the profile, and its runtime's
 * options only when the draft changed them (none stored is `{}`).
 */
export const identityPatch = (assistant) => (values) => ({
  ...profilePatch(values),
  ...(!sameValue(values.runtimeOptions ?? {}, savedOptions(assistant)) && {
    runtimeOptions: Object.keys(values.runtimeOptions || {}).length
      ? { [runtimeOf(assistant)]: values.runtimeOptions }
      : {},
  }),
});
