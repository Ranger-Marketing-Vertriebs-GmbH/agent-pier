// The rules behind OpenClaw's "Model behaviour" surface
// (tests/unit/openclaw-model-options-web.test.js).

/**
 * The thinking levels OpenClaw accepts, in its order (server
 * runtimes/openclaw/openclaw-options.js thinkingLevels). OpenClaw clamps a level the
 * agent's model does not have, so every level is offered for every model.
 */
export const thinkingLevels = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
  "ultra",
]);

/**
 * Whether `assistant` sets none of its own: a temporary team member works with its
 * lead's (the server refuses the same, openclaw-options.js).
 */
export const followsLead = (assistant) =>
  !!assistant?.teamMemberId && assistant.lifetime !== "permanent";

/** The draft's options with `key` at `value`; undefined stores nothing ("Default"). */
export const withOption = (options, key, value) => {
  const { [key]: _old, ...rest } = options || {};
  return value === undefined ? rest : { ...rest, [key]: value };
};

/** The select value of the drafted thinking level; "" is "Default". */
export const thinkingChoice = (options) =>
  thinkingLevels.includes(options?.thinking) ? options.thinking : "";

/** The select value of the drafted fast mode: "on", "off" or "" ("Default"). */
export const fastChoice = (options) =>
  options?.fastMode === true ? "on" : options?.fastMode === false ? "off" : "";

/** What a fast mode choice stores: true, false or nothing. */
export const fastValue = (choice) =>
  choice === "on" ? true : choice === "off" ? false : undefined;

/**
 * Whether loop protection is on without a choice of the owner: for a model of an
 * endpoint connection (`connection`, the drafted model's entry of the model list),
 * the owner's own and often a small or local model. The server compiles the same
 * rule (server runtimes/openclaw/openclaw-config/agent-entry.js loopProtection).
 */
export const loopAutomatic = (connection) => connection?.providerId === "endpoint";

/** The switch's state: the owner's choice, else the automatic rule. */
export const loopChecked = (options, connection) =>
  typeof options?.loopDetection === "boolean"
    ? options.loopDetection
    : loopAutomatic(connection);

/**
 * The draft's options once the switch is `on`: a choice against the automatic rule
 * is stored, one that agrees with it stores nothing, so the agent follows the rule
 * again when its model changes.
 */
export const withLoop = (options, on, connection) =>
  withOption(options, "loopDetection", on === loopAutomatic(connection) ? undefined : on);
