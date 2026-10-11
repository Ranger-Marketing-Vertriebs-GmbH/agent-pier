/** The server asks the owner to confirm a stdio server before it stores or binds one. */
export const stdioConfirmationRequired = (error) =>
  error?.code === "MCP_STDIO_CONFIRMATION_REQUIRED";
