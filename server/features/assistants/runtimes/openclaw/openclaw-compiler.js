import { compileOpenClawConfig, runtimeEnvironment } from "./runtime-config.js";
import { agentDrift, agentPatch, providerPatch } from "./openclaw-config/agent-apply.js";
import { agentExec } from "./openclaw-config/shell.js";
import {
  anyName,
  shadowedSkills,
  shadowingSkillNames,
  skillShadowRoots,
} from "./openclaw-config/skill-shadows.js";
import { mcpLive } from "./openclaw-config/mcp-live.js";
import { mcpServerConfig, mcpServerSignature } from "./openclaw-config/mcp-servers.js";
import {
  configuredAgents,
  telegramLiveChanges,
  telegramLivePatch,
  telegramRevoked,
  telegramSections,
  telegramSnapshot,
} from "./openclaw-config/telegram-senders.js";
import { webToolsSignatures } from "./openclaw-config/web-tools.js";
import {
  browserLivePatch,
  browserProfilesPatch,
  nextBrowserProfiles,
} from "./openclaw-config/browser-profiles.js";
import { dreamingPatch } from "./openclaw-config/dreaming.js";
import {
  advancedSetting,
  advancedSettingById,
  advancedSettings,
  advancedSettingsRuntime,
  auditableSettingValue,
  settingBounds,
  validSettingValue,
} from "./openclaw-config/advanced-settings.js";
import { validateOverride } from "./openclaw-config/overrides.js";

/**
 * The owner's advanced OpenClaw settings (openclaw-config/advanced-settings.js): the
 * allow-listed paths qualified against `runtime`, looked up by path or id, with
 * their bounds, the values they accept and the values the audit log may keep.
 * `validate(path, value)` refuses a value or path the list does not allow.
 */
const openClawAdvancedSettings = Object.freeze({
  runtime: advancedSettingsRuntime,
  list: advancedSettings,
  byPath: advancedSetting,
  byId: advancedSettingById,
  bounds: settingBounds,
  valid: validSettingValue,
  auditable: auditableSettingValue,
  validate: validateOverride,
});

/**
 * The OpenClaw configuration compiler, the pure part of the config sub-port
 * (../agent-runtime.js `config.compiler`): it turns AgentPier's state into
 * `openclaw.json`, live `config.patch` builders and the process environment, and
 * never reaches the Gateway. Feature code reaches it through runtime-for.js
 * (`compilerFor`, or `runtimeFor(agent, supervisor).config.compiler`), so no module
 * outside runtimes/ imports openclaw-config/.
 */
export const openClawCompiler = Object.freeze({
  // A Gateway start's whole configuration (runtime-config.js).
  compile: compileOpenClawConfig,
  // The Gateway's and its CLI's process environment (runtime-config.js).
  environment: runtimeEnvironment,
  // The runtime agent ids a configuration defines.
  configuredAgents,
  // One agent's live apply (AssistantConfig): its exec override for a shell level,
  // its model provider, its entry patch and the readback that proves it took.
  agentExec,
  providerPatch,
  agentPatch,
  agentDrift,
  // Assigned skills a same-named skill in the agent's folders would replace
  // (skill-shadows.js), and every name found there as `{ has(name) }`.
  shadowedSkills,
  skillShadows(root, assistant) {
    const found = shadowingSkillNames(skillShadowRoots(root, assistant));
    return Object.freeze({ has: (name) => found.has(anyName) || found.has(name) });
  },
  // MCP: the live apply, and one compiled server with its signature (OAuth logins).
  mcpLive,
  mcpServerConfig,
  mcpServerSignature,
  // The agents' own Telegram bots: what a start compiles, and the live allowlists.
  telegramSnapshot: (inputs) => telegramSnapshot(telegramSections(inputs)),
  telegramRevoked,
  telegramLiveChanges,
  telegramLivePatch,
  // Web tools: the signatures a save compares with the running start's.
  webToolsSignatures,
  // Browser profiles: the next map, its patch and the live config.patch for it.
  nextBrowserProfiles,
  browserProfilesPatch,
  browserLivePatch,
  // Dreaming: the live config.patch for the owner's setting, or null.
  dreamingPatch,
  advancedSettings: openClawAdvancedSettings,
});
