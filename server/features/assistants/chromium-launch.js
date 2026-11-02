import path from "node:path";

// Chromium flags of every agent browser AgentPier launches itself (the Hermes agents'
// browsers and the launch check), as OpenClaw launches its managed profiles (openclaw
// dist chrome-*.mjs buildOpenClawChromeLaunchArgs, plus the extraArgs of
// openclaw-config/web-tools.js): no first-run UI, sync or crash bubbles, the basic
// password store and the mock keychain (a visible launch never prompts the owner for
// a keyring), no throttling of a window the owner rarely looks at, no proxy and no
// self-reloading error page (policyGuardArgs).
/**
 * A navigation the private-network policy aborts leaves Chromium's network error page,
 * which reloads itself about a second later. OpenClaw removes its request guard as soon
 * as the navigation fails, so a reload before the blocked tab closes reached the private
 * address unchecked (assistant-browser-host-policy-contract). Without auto reload the
 * error page stays an error page.
 */
export const policyGuardArgs = ["--disable-auto-reload"];

const launchArgs = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-features=Translate,MediaRouter",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--password-store=basic",
  "--use-mock-keychain",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  // OpenClaw's managed browser connects directly: the private-network navigation
  // policy checks the address a page resolves to, which a proxy would hide.
  "--no-proxy-server",
  ...policyGuardArgs,
];

// The proxy variables OpenClaw drops from its managed browser's environment
// (omitChromeProxyEnv), so the browser follows only its own command line.
const proxyVariables = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

/** The flags of every launch, before the per-launch ones. */
export const chromiumFlags = ({ headless, platform = process.platform }) => [
  ...launchArgs,
  ...(headless ? ["--headless=new", "--disable-gpu"] : []),
  ...(platform === "linux" ? ["--disable-dev-shm-usage"] : []),
];

/**
 * The command line of one launch, as OpenClaw's: headless without the GPU and, on
 * Linux, without /dev/shm (small in containers). The sandbox is never switched off.
 */
export function chromiumArgs({ port, userData, headless, platform = process.platform }) {
  return [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userData}`,
    ...chromiumFlags({ headless, platform }),
    "about:blank",
  ];
}

/**
 * The launch environment: AgentPier's without the proxy variables, with Chromium's
 * Linux config and cache homes beside the agent's profile unless set, as OpenClaw
 * keeps them in its own folder.
 */
export function chromiumEnvironment({
  directory,
  platform = process.platform,
  env = process.env,
}) {
  const own = { ...env };
  for (const key of proxyVariables) delete own[key];
  if (platform !== "linux") return own;
  const state = path.join(directory, "chromium-state");
  return {
    ...own,
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME || state,
    XDG_CACHE_HOME: env.XDG_CACHE_HOME || state,
  };
}
