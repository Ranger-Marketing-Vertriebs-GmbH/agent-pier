/** The server asks before changing a connection its agents use: the Gateway restarts. */
export const restartRequired = (error) => error?.code === "ASSISTANT_RESTART_REQUIRED";
