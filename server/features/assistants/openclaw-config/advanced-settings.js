import { validTimeZone } from "../heartbeat-schedule.js";

/**
 * The OpenClaw configuration paths the owner may change on the advanced settings
 * page (layer 3, openclaw-config/overrides.js). Everything else stays AgentPier's.
 *
 * `schema` is copied from OpenClaw's `config.schema` and `reloadKind` from
 * `config.schema.lookup` of `advancedSettingsRuntime`; the native interfaces contract
 * compares both with the running Gateway, and a unit test fails as soon as the pinned
 * runtime differs, so every OpenClaw update reviews this list. `limits` narrow the
 * upstream range to values AgentPier's agents still work with; `fallback` is what
 * OpenClaw uses while the path is unset (null: it depends on the host or the model,
 * which the page names in its own words). Labels and help are AgentPier's own
 * translations, keyed by `id`.
 *
 * Only scalar paths that no compiler step, dedicated page or credential owns belong
 * here; none carries a `sensitive` hint.
 */
export const advancedSettingsRuntime = "2026.9.9";

const unbounded = Number.MAX_SAFE_INTEGER;

export const advancedSettings = Object.freeze([
  {
    id: "runTimeout",
    path: "agents.defaults.timeoutSeconds",
    group: "runs",
    schema: { type: "integer", minimum: 0, maximum: unbounded },
    // 0 would let a turn run forever and hold its conversation; one minute is the
    // shortest turn a tool call still fits into.
    limits: { minimum: 60, maximum: 7 * 24 * 3600 },
    unit: "seconds",
    reloadKind: "hot",
    fallback: 48 * 3600,
  },
  {
    id: "thinkingDefault",
    path: "agents.defaults.thinkingDefault",
    group: "runs",
    schema: {
      type: "string",
      enum: [
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
    },
    reloadKind: "hot",
    fallback: null,
  },
  {
    id: "userTimezone",
    path: "agents.defaults.userTimezone",
    group: "runs",
    schema: { type: "string" },
    format: "timeZone",
    reloadKind: "hot",
    fallback: null,
  },
  {
    id: "imageQuality",
    path: "agents.defaults.imageQuality",
    group: "media",
    schema: { type: "string", enum: ["auto", "efficient", "balanced", "high"] },
    reloadKind: "hot",
    fallback: "auto",
  },
  {
    id: "imageMaxDimension",
    path: "agents.defaults.imageMaxDimensionPx",
    group: "media",
    schema: { type: "integer", exclusiveMinimum: 0, maximum: unbounded },
    limits: { minimum: 256, maximum: 8192 },
    unit: "pixels",
    reloadKind: "hot",
    fallback: 1200,
  },
  {
    id: "mediaRetention",
    path: "attachments.ttlHours",
    group: "media",
    schema: { type: "integer", minimum: 1, maximum: 168 },
    unit: "hours",
    reloadKind: "hot",
    fallback: null,
  },
]);

const ianaZone = /^[A-Za-z][A-Za-z0-9_+-]{0,30}(?:\/[A-Za-z0-9_+-]{1,30}){0,2}$/;
const byPath = new Map(advancedSettings.map((setting) => [setting.path, setting]));

export function advancedSetting(path) {
  return byPath.get(path);
}

/** The effective bounds: the upstream schema narrowed by AgentPier's limits. */
export function settingBounds(setting) {
  const { schema, limits = {} } = setting;
  const lower = [schema.minimum, limits.minimum].filter(Number.isFinite);
  const upper = [schema.maximum, limits.maximum].filter(Number.isFinite);
  return {
    minimum: lower.length ? Math.max(...lower) : undefined,
    exclusiveMinimum: schema.exclusiveMinimum,
    maximum: upper.length ? Math.min(...upper) : undefined,
  };
}

/** True when `value` is one the setting accepts; only plain scalars ever are. */
export function validSettingValue(setting, value) {
  const { schema } = setting;
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (schema.type === "integer" && !Number.isSafeInteger(value)) return false;
    const { minimum, exclusiveMinimum, maximum } = settingBounds(setting);
    if (minimum !== undefined && value < minimum) return false;
    if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) return false;
    return maximum === undefined || value <= maximum;
  }
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type !== "string" || typeof value !== "string") return false;
  if (schema.enum) return schema.enum.includes(value);
  // An IANA zone name, never a bare UTC offset the host's Intl may also accept.
  if (setting.format === "timeZone") return ianaZone.test(value) && validTimeZone(value);
  return false;
}
