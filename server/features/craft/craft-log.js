// Logs a failure of the Craft Anything rebuilds by what failed and a stable code:
// the client's own `CRAFT_*` code (craft-mcp-client.js), else CRAFT_REBUILD_FAILED.
// Never the error's message, which may carry a path or Craft Anything's output.

const craftCode = /^CRAFT_[A-Z0-9_]{1,60}$/;

export const craftFailureCode = (error) =>
  typeof error?.code === "string" && craftCode.test(error.code)
    ? error.code
    : "CRAFT_REBUILD_FAILED";

export const logCraftFailure = (what, error) =>
  console.error(`AgentPier could not ${what} (${craftFailureCode(error)}).`);
