import { validTimeZone } from "../heartbeat-schedule.js";

// The shared advanced settings (docs/adr/0007-runtime-descriptor.md, Agents › Runtime
// › Advanced): settings for all agents that are AgentPier's, whatever runtime an
// agent runs on. This module names no runtime. Each runtime states which of them it
// takes and how, by `id`, in its compiler's `advancedSettings` (its own key as
// `path`, the translation of the value, and how a running host takes a change):
// openclaw/openclaw-config/advanced-settings.js, hermes/hermes-config/advanced.js.
//
// `type` is "integer" or "string"; `options` the values of a choice; `minimum` and
// `maximum` the range AgentPier's agents still work with; `format: "timeZone"` an
// IANA zone name; `unit` what a number counts; `fallback` what applies while the
// setting is unset (null: it depends on the host or the model, which the page names
// in its own words). Labels and help are AgentPier's own translations, keyed by `id`
// (web/lib/i18n/*/assistant-advanced.js).
//
// Only scalar settings that no dedicated page or credential owns belong here.
const settings = [
  {
    id: "runTimeout",
    group: "runs",
    type: "integer",
    // Without a limit a turn could run forever and hold its conversation. Below five
    // minutes one mistyped digit would abort nearly every tool-using turn of every
    // agent.
    minimum: 300,
    maximum: 7 * 24 * 3600,
    unit: "seconds",
    fallback: 48 * 3600,
  },
  {
    id: "thinkingDefault",
    group: "runs",
    type: "string",
    options: [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "adaptive",
      "max",
      "ultra",
    ],
    fallback: null,
  },
  {
    id: "userTimezone",
    group: "runs",
    type: "string",
    format: "timeZone",
    fallback: null,
  },
  {
    id: "imageQuality",
    group: "media",
    type: "string",
    options: ["auto", "efficient", "balanced", "high"],
    fallback: "auto",
  },
  {
    id: "imageMaxDimension",
    group: "media",
    type: "integer",
    // Providers refuse larger images once a request carries many of them (Anthropic:
    // 2000 px per side beyond 20 images), which would fail every later turn.
    minimum: 256,
    maximum: 2000,
    unit: "pixels",
    fallback: 1200,
  },
  {
    id: "mediaRetention",
    group: "media",
    type: "integer",
    // Any value turns on a recursive sweep of all stored media, received images and
    // voice notes included; shorter than the longest default turn (48 h) it could
    // remove media a running or follow-up turn still needs. Unset sweeps nothing but
    // outgoing staging.
    minimum: 48,
    maximum: 168,
    unit: "hours",
    fallback: null,
  },
];

/** The shared advanced settings, in the order the page lists them. Frozen. */
export const sharedSettings = Object.freeze(
  settings.map((setting) =>
    Object.freeze({
      ...setting,
      ...(setting.options && { options: Object.freeze([...setting.options]) }),
    }),
  ),
);

const byId = new Map(sharedSettings.map((setting) => [setting.id, setting]));

/** The shared setting `id`, or undefined. */
export const sharedSetting = (id) => byId.get(id);

/** An IANA zone name's shape; never a bare UTC offset the host's Intl may accept. */
export const ianaZone = /^[A-Za-z][A-Za-z0-9_+-]{0,30}(?:\/[A-Za-z0-9_+-]{1,30}){0,2}$/;

/** True when `value` is one the shared `setting` accepts; only plain scalars are. */
export function validSharedValue(setting, value) {
  if (setting.type === "integer")
    return (
      Number.isSafeInteger(value) &&
      (setting.minimum === undefined || value >= setting.minimum) &&
      (setting.maximum === undefined || value <= setting.maximum)
    );
  if (setting.type !== "string" || typeof value !== "string") return false;
  if (setting.options) return setting.options.includes(value);
  if (setting.format === "timeZone") return ianaZone.test(value) && validTimeZone(value);
  return false;
}
