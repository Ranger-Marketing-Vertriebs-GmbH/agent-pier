/** English product copy, addressed through the same semantic keys as the German catalog. */
export const settings = Object.freeze({
  invalidSavedPreferences: "Saved settings are invalid.",
  invalidPreferences: "Invalid settings.",
  invalidNetworkConfig:
    "Invalid network configuration: the bind address must be 0.0.0.0 or ::, hosts are names or IPs without scheme, path or port (at most 20).",
  networkLocked:
    "Over network access, network mode can only be turned off. Change the bind address and host list locally or via Tailscale.",
  restartFailed:
    "The service could not be restarted. Please restart it manually: npm run service:install or npm start.",
});
