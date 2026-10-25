import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { capabilityTools } from "../native-capabilities.js";
import { browserProfileMap, compiledProfile } from "./browser-profiles.js";

// Verified against OpenClaw 2026.10.3, see docs/assistant-web-tools-qualification.md.
export const imageModel = "openai/gpt-image-2";

export const documentExtractPlugin = "document-extract";
/**
 * Whether the runtime `installed` (a runtime descriptor) bundles OpenClaw's document
 * extraction plugin, which reads PDF text and page images (2026.10.3 has it).
 */
export function hasDocumentExtract(installed) {
  if (typeof installed?.entryPath !== "string") return false;
  return fs.existsSync(
    path.join(
      path.dirname(installed.entryPath),
      "dist",
      "extensions",
      documentExtractPlugin,
      "openclaw.plugin.json",
    ),
  );
}

/**
 * Which web tools this runtime can actually serve. `webTools` is
 * `{ search, browser, searchPlugins, images, pdf }`: the WebSearchSettings.resolve()
 * result, the detectBrowser() result, the runtime descriptor's bundled search plugins,
 * the ChatGPT image readiness, the PdfModelSettings.resolve() result and whether the
 * runtime bundles PDF extraction (hasDocumentExtract). A
 * provider whose plugin the runtime lacks (old or rollback runtime) is unavailable:
 * OpenClaw would offer web_search without a provider and fail each call.
 */
export function webToolsAvailability(webTools) {
  const search = webTools?.search;
  return {
    // A ChatGPT account (an `openai` OAuth profile) that is signed in: OpenClaw routes
    // gpt-image-2 through it (docs/tools/image-generation.md of 2026.10.3).
    createImages: webTools?.images?.ready === true,
    // The runtime bundles the extraction plugin the pdf tool needs for non-native
    // models. Agents read with their own model; the owner's fallback is optional.
    readPdfs: webTools?.documentExtract === true,
    browser: !!(webTools?.browser?.available && webTools.browser.executablePath),
    webSearch: !!(
      search?.provider &&
      !search.unavailable &&
      webTools?.searchPlugins?.[search.provider]?.directory
    ),
  };
}

/**
 * The Gateway sections the web capabilities need, for the startup configuration.
 * Pure. Every capability the runtime can serve is compiled, whether an agent uses it
 * yet or not: the global `tools.allow` is only an upper bound (each agent's entry
 * names its own tools), so switching a capability for one agent changes only its
 * entry and its browser profile, which the running Gateway applies live. Under the
 * team plugin's restrictive plugins.allow, enabling the browser block or a plugin
 * live needs a Gateway restart (docs/assistant-web-tools-qualification.md).
 * - `tools`: tool names to append to the global `tools.allow`.
 * - `web`: `tools.web`, or undefined.
 * - `browser`: the root `browser` block, or undefined (keep `{ enabled: false }`).
 * - `pdf`: `{ connectionId, modelId }` of the fallback PDF model, `{}` without a
 *   usable one, or undefined while no agent can read PDFs.
 * - `plugins`: `{ allow, paths, entries }` to add to the plugin configuration.
 */
export function webToolsSections({ profiles, webTools, port, only }) {
  const available = webToolsAvailability(webTools);
  // `only` (capability keys) limits the result to those, for webToolsSignatures.
  const active = (key) => (!only || only.includes(key)) && available[key] !== false;
  const sections = {
    tools: Object.entries(capabilityTools).flatMap(([key, tools]) =>
      active(key) ? tools : [],
    ),
    web: undefined,
    browser: undefined,
    media: undefined,
    pdf: undefined,
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
  // An explicit model keeps image_generate on the account's OpenAI route instead of
  // auto-detection; the timeout follows OpenClaw's hosted image defaults.
  if (active("createImages"))
    sections.media = { image: { primary: imageModel, timeoutMs: 180000 } };
  // Ids only: AssistantProviderSynchronization.prepare resolves them into
  // agents.defaults.pdfModel and its provider before the Gateway starts, or compiles
  // a placeholder without a fallback; the tool guard names each call's model.
  if (active("readPdfs")) {
    sections.pdf =
      webTools.pdf?.ready === true
        ? { connectionId: webTools.pdf.connectionId, modelId: webTools.pdf.modelId }
        : {};
    // Bundled, but the restrictive allow list leaves it off; without it the pdf tool
    // refuses every PDF a non-native model reads ("PDF extraction disabled").
    sections.plugins.allow.push(documentExtractPlugin);
  }
  if (active("browser")) {
    // An explicit root block activates the bundled plugin; listing it is explicit.
    sections.plugins.allow.push("browser");
    // Every agent drives a persistent profile of its own (browser-profiles.js); the
    // tool guard pins each call to it, so the default profile is never used.
    const own = Object.fromEntries(
      Object.entries(
        browserProfileMap({ profiles, browser: webTools.browser, port }),
      ).map(([name, entry]) => [name, compiledProfile(entry)]),
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
      extraArgs: ["--use-mock-keychain", ...antiThrottlingArgs],
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

/**
 * A visible agent browser is a normal window the owner rarely looks at, often behind
 * others: without these Chromium treats it as occluded, lowers its renderer's priority
 * and throttles its timers, and every snapshot or click then outlasts OpenClaw's
 * 20-second browser budget (AGENTPIER-240). Harmless for a headless browser.
 */
export const antiThrottlingArgs = [
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

/** Applies webToolsSections to a configuration whose plugins carry an allow list. */
export function applyWebTools(config, sections) {
  if (!sections.tools.length) return config;
  config.tools.allow = [...config.tools.allow, ...sections.tools];
  if (sections.web) config.tools.web = sections.web;
  if (sections.browser) config.browser = sections.browser;
  if (sections.media)
    config.agents = {
      ...config.agents,
      defaults: { ...config.agents?.defaults, mediaModels: sections.media },
    };
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
 * Key-free fingerprints of the global sections these inputs compile, per capability
 * key. The CDP ports follow the Gateway port and are left out: a restart picks a new
 * port anyway. The agents' own browser profiles are left out as well, since they
 * apply live; what remains depends only on what the runtime can serve. A save
 * compares only the capabilities some agent uses (WebToolsChanges.differs): a stale
 * section nobody is offered needs no restart until an agent switches it on.
 */
export function webToolsSignatures({ webTools }) {
  return Object.fromEntries(
    Object.keys(capabilityTools).map((key) => [
      key,
      createHmac("sha256", signatureSecret)
        .update(
          JSON.stringify(
            webToolsSections({ profiles: [], webTools, port: 0, only: [key] }),
          ),
        )
        .digest("hex"),
    ]),
  );
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
    // The browser profiles the Gateway runs, with their CDP ports; live applies
    // update them (browser-profile-sync.js).
    browserProfiles: available
      ? browserProfileMap({ profiles, browser: webTools.browser, port })
      : {},
    port,
    visibleBrowser: available && webTools.browser.visible?.available === true,
    // The executable this start compiled (the managed browser may not be removed).
    browserExecutable: available ? webTools.browser.executablePath : null,
    searchPlugins: webTools?.searchPlugins || {},
    // Whether the runtime bundles PDF extraction; a save compares with the same.
    documentExtract: webTools?.documentExtract === true,
    tools: webToolsSections({ profiles, webTools, port: 0 }).tools,
    signatures: webToolsSignatures({ webTools }),
  };
}
