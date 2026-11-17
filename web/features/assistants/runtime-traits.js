// How an agent's runtime behaves within a capability (ADR 0007): each runtime states
// its traits and the server carries them beside the capability in the runtime view
// (`runtimeInfo.capabilities[feature][trait]`, also for each entry of the runtime
// list). The web app reads them here and never compares a runtime id.
//
// The defaults mirror the server's schema (runtimes/runtime-traits.js), where each
// trait is described; tests/unit/runtime-traits-web.test.js keeps both equal. They
// answer for a view that carries no traits: an agent still loading, a runtime whose
// list has not arrived.
export const traitDefaults = Object.freeze({
  approvals: Object.freeze({
    shellLevels: Object.freeze(["off", "approval", "full"]),
    allowlist: "patterns",
  }),
  agentFiles: Object.freeze({ memoryFormat: "markdown", dreaming: "host" }),
  models: Object.freeze({ chatgptLogin: "any" }),
  channelBots: Object.freeze({ peopleApply: "live" }),
  skills: Object.freeze({
    learnsByDefault: false,
    userAgentsLearn: false,
    writesWhenAsked: false,
    channelBotsLearn: false,
  }),
  sessions: Object.freeze({ chatFolders: false }),
  host: Object.freeze({ process: "shared", install: "builtin" }),
});

/**
 * The value of `trait` of `feature` in the runtime view `runtimeInfo` (`{ id, name,
 * capabilities }`), or its default where the view states none. A trait nobody
 * defined is a TypeError.
 */
export function traitOf(runtimeInfo, feature, trait) {
  if (!Object.hasOwn(traitDefaults[feature] || {}, trait))
    throw new TypeError(`Unknown runtime trait: ${feature}.${trait}`);
  const stated = runtimeInfo?.capabilities?.[feature];
  return stated && Object.hasOwn(stated, trait)
    ? stated[trait]
    : traitDefaults[feature][trait];
}
