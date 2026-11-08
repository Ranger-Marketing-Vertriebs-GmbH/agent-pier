import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readHermesConfig } from "./home-merge.js";

// The owner's advanced settings for all agents (advanced-config.js, Agents › Runtime ›
// Advanced) on a Hermes agent: the ones with a faithful Hermes equivalent, verified
// against Hermes v0.22.5 (hermes_cli/config_defaults.py unless named otherwise).
// docs/hermes-runtime.md lists each setting and why the others stay OpenClaw's.
//
// - Thinking level → `agent.reasoning_effort` in config.yaml, which every session
//   reads again at each turn unless that chat pinned its own level
//   (gateway/session_policy.py `effective`, FOLLOW_AGENT_KEYS): a change needs no
//   restart (liveConfigChange). Hermes takes none, minimal … ultra
//   (hermes_constants.py parse_reasoning_effort); OpenClaw's "off" is Hermes's
//   "none". Hermes has no "adaptive" level: it thinks adaptively on models that can
//   whatever the level (agent/anthropic_adapter.py _thinking_kwargs), so "adaptive"
//   leaves Hermes's own default.
// - Time zone → the processes' `HERMES_TIMEZONE` (hermes-environment.js), which
//   hermes_time.py reads before config.yaml's `timezone`: the agent's clock and
//   every cron expression. It lives in no file, so an older AgentPier, which pins
//   routines to the host's zone, starts the agent in the host's zone again. The
//   config key stays AgentPier's and is removed: the gateway would copy it over the
//   variable at its start (gateway/run.py). A change restarts the agent; AgentPier
//   pins routines of other zones to it (hermes-routine-jobs.js).
// - Time limit per task: no equivalent. `agent.run_budget_seconds` only adds a
//   wrap-up notice at 80 % and never stops the task (agent/conversation_loop.py).
// - Image quality, maximum image size, media file retention: no equivalent. Hermes
//   sends attached images as they are (agent/image_routing.py), scales tool images
//   to a fixed 1568 px (tools/vision_tools.py) and sweeps its media caches after a
//   fixed 24 hours (agent/provider_media.py MEDIA_CACHE_MAX_AGE_HOURS).
//
// None of these touches access, approvals, toolsets, plugins or management
// (tests/unit/hermes-advanced.test.js).

/**
 * The Hermes version this mapping was verified against. Another installation (an
 * update before AgentPier approved it, a rollback) starts with Hermes's own defaults
 * and the owner's values stay stored, as OpenClaw's overrides do; a unit test fails
 * as soon as hermes-manifest.json pins another version, so every Hermes update
 * reviews this list.
 */
export const hermesAdvancedRuntime = "0.22.5";

const levels = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const ianaZone = /^[A-Za-z][A-Za-z0-9_+-]{0,30}(?:\/[A-Za-z0-9_+-]{1,30}){0,2}$/;

// `path`: the config.yaml key, or the process variable (`env`); `reloadKind`: how a
// running Hermes agent takes a change.
const settings = Object.freeze([
  Object.freeze({
    id: "thinkingDefault",
    path: "agent.reasoning_effort",
    reloadKind: "hot",
    // The owner's level as Hermes reads it; undefined leaves Hermes's default.
    value: (level) =>
      level === "off" ? "none" : levels.includes(level) ? level : undefined,
  }),
  Object.freeze({
    id: "userTimezone",
    path: "HERMES_TIMEZONE",
    env: true,
    reloadKind: "restart",
    value: (zone) => (typeof zone === "string" && ianaZone.test(zone) ? zone : undefined),
  }),
]);

const byPath = new Map(settings.map((setting) => [setting.path, setting]));
const byId = new Map(settings.map((setting) => [setting.id, setting]));

/**
 * The advanced settings of the Hermes compiler (`config.compiler.advancedSettings`):
 * the settings Hermes takes, by AgentPier's setting id, each with its Hermes key as
 * `path`. `validate(path, value)` refuses a key the list does not name or a value it
 * cannot compile.
 */
export const hermesAdvancedSettings = Object.freeze({
  runtime: hermesAdvancedRuntime,
  list: settings,
  byPath: (path) => byPath.get(path),
  byId: (id) => byId.get(id),
  validate(path, value) {
    const setting = byPath.get(String(path));
    if (!setting || setting.value(value) === undefined)
      throw new TypeError(`Hermes takes no advanced value for ${path}.`);
    return { path: setting.path, value: setting.value(value) };
  },
});

// The owner's value of `setting` that `advanced` compiles, or undefined (unset,
// unmappable, or an installation the mapping is not approved for).
function compiled(advanced, { id, value }) {
  if (advanced?.version !== hermesAdvancedRuntime) return undefined;
  const values = advanced.values || {};
  return Object.hasOwn(values, id) ? value(values[id]) : undefined;
}

/**
 * The config.yaml entries (`[[keys, value]]`, home.js) of `advanced`: `{ version,
 * values }`, the installed Hermes version and the owner's values by setting id
 * (advanced-config.js advancedValues). Each key is AgentPier's while the values are
 * known: unset, unmappable or on an unapproved version it is removed, so Hermes's
 * default applies; `timezone` is always removed (the zone travels as HERMES_TIMEZONE,
 * advancedZone). Without `advanced` the keys stay as they are. Pure.
 */
export function advancedEntries(advanced) {
  if (!advanced || typeof advanced !== "object") return [];
  return [
    ...settings
      .filter((setting) => !setting.env)
      .map((setting) => [setting.path.split("."), compiled(advanced, setting)]),
    [["timezone"], undefined],
  ];
}

/** The HERMES_TIMEZONE `advanced` gives the agent's processes, or null (the host's). */
export const advancedZone = (advanced) =>
  compiled(advanced, byId.get("userTimezone")) ?? null;

/**
 * A home (as hermes-compiler.js `write` takes it) of the advanced keys alone, for a
 * start without a desired state: merged into the agent's config.yaml in `folder`
 * when there is one, nothing otherwise (a first start writes the whole home).
 */
export function advancedHome(advanced, { hermesHome } = {}) {
  const found = !!hermesHome && fs.existsSync(path.join(hermesHome, "config.yaml"));
  const config = found ? advancedEntries(advanced) : [];
  return {
    files: config.length ? { "config.yaml": "" } : {},
    remove: [],
    config,
    env: { owned: [], values: {} },
  };
}

// The config.yaml keys a running gateway reads again at each turn.
const liveKeys = settings.filter((s) => !s.env && s.reloadKind === "hot");

/**
 * Whether config.yaml went from `before` to `after` (texts) only in keys a running
 * gateway reads at each turn (the thinking level), so no restart is needed. False for
 * anything it cannot read. Pure.
 */
export function liveConfigChange(before, after) {
  try {
    const [a, b] = [readHermesConfig(before), readHermesConfig(after)];
    for (const config of [a, b])
      for (const { path: key } of liveKeys) {
        const [section, name] = key.split(".");
        if (!config[section] || typeof config[section] !== "object") continue;
        delete config[section][name];
        if (!Object.keys(config[section]).length) delete config[section];
      }
    return isDeepStrictEqual(a, b);
  } catch {
    return false;
  }
}
