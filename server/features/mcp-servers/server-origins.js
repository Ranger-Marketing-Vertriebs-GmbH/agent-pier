/**
 * How the owner set a new MCP server up (wizard source). The create route accepts
 * only these; anything else, `managed` included, counts as manual there.
 */
export const MCP_SERVER_WIZARD_ORIGINS = Object.freeze(["manual", "paste", "directory"]);

/**
 * Every origin the audit allowlist keeps: the wizard's and `managed`, a row a tool of
 * AgentPier (such as REA) set up itself.
 */
export const MCP_SERVER_ORIGINS = Object.freeze([
  ...MCP_SERVER_WIZARD_ORIGINS,
  "managed",
]);
