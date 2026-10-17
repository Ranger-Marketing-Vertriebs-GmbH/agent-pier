import { createHmac, randomBytes } from "node:crypto";
import { capabilityTools, usedCapabilities } from "../native-capabilities.js";
import { browserProfileMap } from "./browser-profiles.js";

// Verified against OpenClaw 2026.10.3, see docs/assistant-web-tools-qualification.md.

/**
 * Which web tools this runtime can actually serve. `webTools` is
 * `{ search, browser, searchPlugins }`: the WebSearchSettings.resolve() result, the
 * detectBrowser() result and the runtime descriptor's bundled search plugins. A
 * provider whose plugin the runtime lacks (old or rollback runtime) is unavailable:
 * OpenClaw would offer web_search without a provider and fail each call.
 */
export function webToolsAvailability(webTools) {
  const search = webTools?.search;
  return {
    browser: !!(webTools?.browser?.available && webTools.browser.executablePath),
    webSearch: !!(
      search?.provider &&
      !search.unavailable &&
      webTools?.searchPlugins?.[search.provider]?.directory
    ),
  };
}

/**
 * The Gateway sections the agents' web capabilities need, for the startup
 * configuration. Pure; empty (no tools, no sections) when no eligible profile uses a
 * web capability or none of the used ones is available.
 * - `tools`: tool names to append to the global `tools.allow`.
 * - `web`: `tools.web`, or undefined.
 * - `browser`: the root `browser` block, or undefined (keep `{ enabled: false }`).
 * - `plugins`: `{ allow, paths, entries }` to add to the plugin configuration.
 */
export function webToolsSections({ profiles, webTools, port }) {
  const used = usedCapabilities(profiles);
  const available = webToolsAvailability(webTools);
  const active = (key) => used.has(key) && available[key] !== false;
  const sections = {
    tools: Object.entries(capabilityTools).flatMap(([key, tools]) =>
      active(key) ? tools : [],
    ),
    web: undefined,
    browser: undefined,
    plugins: { allow: [], paths: [], entries: {} },
  };
  const web = {};
  if (active("webSearch")) {
    const { provider, key } = webTools.search;
    const plugin = webTools.searchPlugins[provider];
    web.search = { provider };
    sections.plugins.allow.push(plugin.id);
    sections.plugins.paths.push(plugin.directory);
    // The only place the key is written; config.get redacts it (sensitive).
    if (key)
      sections.plugins.entries[plugin.id] = { config: { webSearch: { apiKey: key } } };
  }
  // Private and internal targets are refused before any request is sent.
  if (active("webFetch"))
    web.fetch = { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } };
  if (Object.keys(web).length) sections.web = web;
  if (active("browser")) {
    // An explicit root block activates the bundled plugin; listing it is explicit.
    sections.plugins.allow.push("browser");
    // Every agent drives a persistent profile of its own (browser-profiles.js); the
    // tool guard pins each call to it, so the default profile is never used.
    const own = Object.fromEntries(
      Object.entries(
        browserProfileMap({ profiles, browser: webTools.browser, port }),
      ).map(([name, { cdpPort, headless }]) => [
        name,
        { driver: "openclaw", cdpPort, headless },
      ]),
    );
    sections.browser = {
      enabled: true,
      defaultProfile: "openclaw",
      evaluateEnabled: false,
      // importprofile would copy cookies from the owner's system browser profile.
      allowSystemProfileImport: false,
      headless: true,
      executablePath: webTools.browser.executablePath,
      // OpenClaw uses the macOS keychain for a new profile it launches visibly, which
      // can prompt the owner; the mock keychain never does (ignored elsewhere).
      // extraArgs is global, so every profile keeps the same cookie protection.
      extraArgs: ["--use-mock-keychain"],
      // The plugin adds implicit "user" (the signed-in Chrome) and "chrome"
      // (extension) profiles unless defined; both become isolated managed profiles.
      // CDP ports follow OpenClaw's range: first CDP port = gateway port + 11.
      profiles: {
        user: { driver: "openclaw", cdpPort: port + 12 },
        chrome: { driver: "openclaw", cdpPort: port + 13 },
        ...own,
      },
      // No ssrfPolicy: the default blocks private targets, while an explicit
      // dangerouslyAllowPrivateNetwork: false makes every navigation fail.
    };
  }
  return sections;
}

/** Applies webToolsSections to a configuration whose plugins carry an allow list. */
export function applyWebTools(config, sections) {
  if (!sections.tools.length) return config;
  config.tools.allow = [...config.tools.allow, ...sections.tools];
  if (sections.web) config.tools.web = sections.web;
  if (sections.browser) config.browser = sections.browser;
  const { allow, paths, entries } = sections.plugins;
  config.plugins.allow = [...(config.plugins.allow || []), ...allow];
  if (paths.length)
    config.plugins.load = {
      ...config.plugins.load,
      paths: [...(config.plugins.load?.paths || []), ...paths],
    };
  config.plugins.entries = { ...config.plugins.entries, ...entries };
  return config;
}

// Per process: a signature is only compared with one from the same AgentPier process,
// and a search key cannot be recovered from it by guessing.
const signatureSecret = randomBytes(32);

/**
 * A key-free fingerprint of the global sections these inputs compile. The CDP ports
 * follow the Gateway port and are left out: a restart picks a new port anyway.
 */
export function webToolsSignature({ profiles, webTools }) {
  return createHmac("sha256", signatureSecret)
    .update(JSON.stringify(webToolsSections({ profiles, webTools, port: 0 })))
    .digest("hex");
}

/**
 * What the supervisor keeps about a Gateway start: the availability live applies
 * grant against, the runtime's search plugins, the tool names the start appended to
 * the global `tools.allow` (live MCP applies rewrite that list) and the signature of
 * the compiled sections. It never holds the search key.
 */
export function webToolsSnapshot({ profiles, webTools, port = 0 }) {
  const available = webToolsAvailability(webTools).browser;
  return {
    availability: webToolsAvailability(webTools),
    // The agents' browser profiles this start compiled, with their CDP ports.
    browserProfiles:
      available && usedCapabilities(profiles).has("browser")
        ? browserProfileMap({ profiles, browser: webTools.browser, port })
        : {},
    visibleBrowser: available && webTools.browser.visible?.available === true,
    // The executable this start compiled (the managed browser may not be removed).
    browserExecutable: available ? webTools.browser.executablePath : null,
    searchPlugins: webTools?.searchPlugins || {},
    tools: webToolsSections({ profiles, webTools, port: 0 }).tools,
    signature: webToolsSignature({ profiles, webTools }),
  };
}
