// The Runtime tab's one draft (handoff 5.2): the agents switch, the host's concurrent
// team members, dreaming and the advanced values for all agents: the shared settings
// and each runtime's own described ones. Each part keeps its own server call and
// revision, so a partial save only repeats what failed.
import { assistantAdvancedCopy } from "../../../lib/i18n/messages/assistant-advanced.js";
import { assistantDreamingCopy } from "../../../lib/i18n/messages/assistant-dreaming.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { operationsCopy } from "../../../lib/i18n/messages/operations.js";
import { settingsPageCopy } from "../../../lib/i18n/messages/settings.js";
import {
  capacityInvalid,
  capacityRange,
  dreamingStep,
  featureStep,
  fieldCheckStep,
  hostCapacityStep,
} from "../../settings/settings-steps.js";

export const dreamingKeys = ["dreamingEnabled", "dreamingHour", "dreamingTimeZone"];
// Advanced values live under their own prefix, so no setting id meets another key.
export const advancedKey = (id) => `advanced:${id}`;
// A runtime's own described field, by the runtime's id and the field's.
export const ownKey = (runtime, field) => `own:${runtime}:${field}`;
const numeric = (setting) => setting.type === "integer" || setting.type === "number";

export const dreamingServer = (dreaming) => ({
  dreamingEnabled: dreaming?.enabled === true,
  dreamingHour: dreaming?.hour ?? 3,
  dreamingTimeZone: dreaming?.timeZone ?? "UTC",
});

/**
 * The stored override of every shared setting ("" means the default), and of every
 * runtime's own field its stored value, else its default: an own field always shows
 * the value that applies.
 */
export const advancedServer = (data) =>
  Object.fromEntries([
    ...(data?.settings || []).map((s) => [advancedKey(s.id), s.override ?? ""]),
    ...(data?.runtimes || []).flatMap((runtime) =>
      (runtime.own || []).map((field) => [
        ownKey(runtime.id, field.id),
        field.value ?? field.default,
      ]),
    ),
  ]);

/** The flat server state of the tab; parts that are not loaded yet stay out. */
export function runtimeServer({ enabled, teamSettings, dreaming, advanced }) {
  return {
    agentsEnabled: enabled,
    ...(teamSettings ? { hostMaxConcurrent: teamSettings.hostMaxConcurrent ?? "" } : {}),
    ...(dreaming ? dreamingServer(dreaming) : {}),
    ...advancedServer(advanced),
  };
}

/** A numeric advanced value outside its range, as the field's message; else "". */
export function advancedRangeError(setting, value) {
  if (!numeric(setting) || value === "") return "";
  const low = setting.minimum ?? (setting.exclusiveMinimum ?? 0) + 1;
  const ok =
    Number.isFinite(value) &&
    (setting.type !== "integer" || Number.isInteger(value)) &&
    value >= low &&
    (setting.maximum === undefined || value <= setting.maximum);
  return ok
    ? ""
    : assistantAdvancedCopy.outOfRange(
        assistantAdvancedCopy.settings[setting.id].label,
        low,
        setting.maximum,
      );
}

// Whether `value` is whole steps above `base`, within floating point error.
function onStep(value, base, step) {
  const steps = (value - base) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/**
 * A value the described `field` refuses (the server checks again), as the field's
 * message under its `label`; else "". An emptied number means the default.
 */
export function ownFieldError(field, value, label) {
  const refused = () =>
    field.min !== undefined && field.max !== undefined
      ? assistantAdvancedCopy.ownRange(label, field.min, field.max)
      : assistantAdvancedCopy.invalidValue(label);
  if (field.type === "number") {
    if (value === "") return "";
    const ok =
      Number.isFinite(value) &&
      (field.min === undefined || value >= field.min) &&
      (field.max === undefined || value <= field.max) &&
      (field.step === undefined || onStep(value, field.min ?? 0, field.step));
    return ok ? "" : refused();
  }
  if (field.type === "text")
    return typeof value === "string" && value.length <= 500 ? "" : refused();
  return "";
}

export const capacityError = (values) =>
  capacityInvalid(values.hostMaxConcurrent)
    ? assistantCopy.team.capacityRange(capacityRange.min, capacityRange.max)
    : "";

/**
 * The save chain: field checks first (nothing is sent while a value is out of range),
 * then the switch, the host capacity, dreaming and one step per advanced value: the
 * shared `settings`, then the runtimes' `own` fields (advanced-scopes.js ownList).
 */
export function runtimeSteps({
  api,
  setEnabled,
  refresh,
  settings = [],
  own = [],
  onAdvanced,
}) {
  return [
    fieldCheckStep({
      id: "capacityRange",
      fields: ["hostMaxConcurrent"],
      error: capacityError,
    }),
    fieldCheckStep({
      id: "advancedRanges",
      fields: [
        ...settings.filter(numeric).map((s) => advancedKey(s.id)),
        ...own.map(({ key }) => key),
      ],
      error: (values) =>
        settings
          .map((s) => advancedRangeError(s, values[advancedKey(s.id)]))
          .find(Boolean) ||
        own
          .map(({ field, key, text }) => ownFieldError(field, values[key], text.label))
          .find(Boolean) ||
        "",
    }),
    featureStep({
      label: () => operationsCopy.sections.assistants,
      setEnabled,
      notApplied: () => settingsPageCopy.agentsNotApplied,
    }),
    hostCapacityStep({
      label: () => assistantCopy.team.settings,
      save: api.teamSettings,
      refresh: refresh.assistants,
    }),
    dreamingStep({
      label: () => assistantDreamingCopy.title,
      save: api.saveDreaming,
      // Memory switched on for agents shows on their Capabilities tab.
      refresh: () => Promise.all([refresh.dreaming(), refresh.assistants()]),
    }),
    ...settings.map((setting) => ({
      id: `advanced-${setting.id}`,
      keys: [advancedKey(setting.id)],
      label: assistantAdvancedCopy.settings[setting.id].label,
      run: async ({ values, confirmations }) => {
        const value = values[advancedKey(setting.id)];
        const next = await api.saveAdvancedSetting({
          setting: setting.id,
          value: value === "" ? null : value,
          ...confirmations,
        });
        onAdvanced?.(next);
        return next;
      },
    })),
    ...own.map(({ runtime, field, key, text }) => ({
      id: `own-${runtime}-${field.id}`,
      keys: [key],
      label: text.label,
      run: async ({ values, confirmations }) => {
        const value = values[key];
        const next = await api.saveAdvancedSetting({
          runtime,
          field: field.id,
          // The default (and an emptied number) resets the field, so it follows its
          // default again. An emptied text is a value: the empty text.
          value:
            (field.type === "number" && value === "") || value === field.default
              ? null
              : value,
          ...confirmations,
        });
        onAdvanced?.(next);
        return next;
      },
    })),
  ];
}
