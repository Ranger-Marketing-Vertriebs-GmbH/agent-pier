import { validTimeZone } from "../../../heartbeat-schedule.js";
import { ianaZone, sharedSetting } from "../../shared-settings.js";

/**
 * How OpenClaw takes the shared advanced settings (../../shared-settings.js, which
 * are AgentPier's): the openclaw.json path of each one it takes, by the shared id.
 * These are the only paths the owner may change on the advanced settings page (layer
 * 3, openclaw-config/overrides.js). Everything else stays AgentPier's.
 *
 * `schema` is copied from OpenClaw's `config.schema` and `reloadKind` from
 * `config.schema.lookup` of `advancedSettingsRuntime`; the native interfaces contract
 * compares both with the running Gateway, and a unit test fails as soon as the pinned
 * runtime differs, so every OpenClaw update reviews this list. The shared setting's
 * range narrows the upstream one as `limits`; its group, unit, format and `fallback`
 * (what OpenClaw uses while the path is unset) are repeated on each entry.
 *
 * Only scalar paths that no compiler step, dedicated page or credential owns belong
 * here; none carries a `sensitive` hint.
 */
export const advancedSettingsRuntime = "2026.11.3";

const unbounded = Number.MAX_SAFE_INTEGER;

const taken = [
  {
    id: "runTimeout",
    path: "agents.defaults.timeoutSeconds",
    schema: { type: "integer", minimum: 0, maximum: unbounded },
    reloadKind: "hot",
  },
  {
    id: "thinkingDefault",
    path: "agents.defaults.thinkingDefault",
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
  },
  {
    id: "userTimezone",
    path: "agents.defaults.userTimezone",
    schema: { type: "string" },
    reloadKind: "hot",
  },
  {
    id: "imageQuality",
    path: "agents.defaults.imageQuality",
    schema: { type: "string", enum: ["auto", "efficient", "balanced", "high"] },
    reloadKind: "hot",
  },
  {
    id: "imageMaxDimension",
    path: "agents.defaults.imageMaxDimensionPx",
    schema: { type: "integer", exclusiveMinimum: 0, maximum: unbounded },
    reloadKind: "hot",
  },
  {
    id: "mediaRetention",
    path: "attachments.ttlHours",
    schema: { type: "integer", minimum: 1, maximum: 168 },
    reloadKind: "hot",
  },
];

export const advancedSettings = Object.freeze(
  taken.map(({ id, path, schema, reloadKind }) => {
    const { group, minimum, maximum, unit, format, fallback } = sharedSetting(id);
    const bounded = minimum !== undefined || maximum !== undefined;
    return {
      id,
      path,
      group,
      schema,
      ...(bounded && { limits: { minimum, maximum } }),
      ...(unit && { unit }),
      ...(format && { format }),
      reloadKind,
      fallback,
    };
  }),
);

const byPath = new Map(advancedSettings.map((setting) => [setting.path, setting]));

export function advancedSetting(path) {
  return byPath.get(path);
}

const byId = new Map(advancedSettings.map((setting) => [setting.id, setting]));

export function advancedSettingById(id) {
  return byId.get(id);
}

/**
 * A value the audit log may keep for the setting with this `id`: null (unset) or a
 * scalar of the setting's upstream type, not AgentPier's narrower limits, so an
 * override stored before a limit changed is still named. None is a credential.
 */
export function auditableSettingValue(id, value) {
  const setting = byId.get(id);
  if (!setting) return false;
  if (value === null) return true;
  const { schema } = setting;
  if (schema.type === "integer") return Number.isSafeInteger(value);
  if (schema.type !== "string" || typeof value !== "string") return false;
  if (schema.enum) return schema.enum.includes(value);
  return setting.format === "timeZone" && ianaZone.test(value);
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
