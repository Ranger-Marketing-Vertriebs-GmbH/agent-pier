// The rules behind OpenClaw's "Thinking and speed" surface
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
