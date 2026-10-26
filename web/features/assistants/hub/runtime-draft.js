// The Runtime tab's one draft (handoff 5.2): the agents switch, the host's concurrent
// team members, dreaming and the advanced agent service values. Each part keeps its
// own server call and revision, so a partial save only repeats what failed.
import { assistantAdvancedCopy } from "../../../lib/i18n/messages/assistant-advanced.js";
import { assistantDreamingCopy } from "../../../lib/i18n/messages/assistant-dreaming.js";
import { assistantTeamCopy } from "../../../lib/i18n/messages/assistant-team.js";
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
const numeric = (setting) => setting.type === "integer" || setting.type === "number";

export const dreamingServer = (dreaming) => ({
  dreamingEnabled: dreaming?.enabled === true,
  dreamingHour: dreaming?.hour ?? 3,
  dreamingTimeZone: dreaming?.timeZone ?? "UTC",
});

/** The stored override of every advanced setting; "" means OpenClaw's default. */
export const advancedServer = (data) =>
  Object.fromEntries(
    (data?.settings || []).map((s) => [advancedKey(s.id), s.override ?? ""]),
  );

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

export const capacityError = (values) =>
  capacityInvalid(values.hostMaxConcurrent)
    ? assistantTeamCopy.capacityRange(capacityRange.min, capacityRange.max)
    : "";

/**
 * The save chain: field checks first (nothing is sent while a value is out of range),
 * then the switch, the host capacity, dreaming and one step per advanced value.
 */
export function runtimeSteps({ api, setEnabled, refresh, settings = [], onAdvanced }) {
  return [
    fieldCheckStep({
      id: "capacityRange",
      fields: ["hostMaxConcurrent"],
      error: capacityError,
    }),
    fieldCheckStep({
      id: "advancedRanges",
      fields: settings.filter(numeric).map((s) => advancedKey(s.id)),
      error: (values) =>
        settings
          .map((s) => advancedRangeError(s, values[advancedKey(s.id)]))
          .find(Boolean) || "",
    }),
    featureStep({
      label: () => operationsCopy.sections.assistants,
      setEnabled,
      notApplied: () => settingsPageCopy.agentsNotApplied,
    }),
    hostCapacityStep({
      label: () => assistantTeamCopy.settings,
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
          path: setting.path,
          value: value === "" ? null : value,
          ...confirmations,
        });
        onAdvanced?.(next);
        return next;
      },
    })),
  ];
}
