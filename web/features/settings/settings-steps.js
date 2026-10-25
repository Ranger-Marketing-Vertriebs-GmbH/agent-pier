import api from "../../lib/api.js";
import { assistantDreamingCopy } from "../../lib/i18n/messages/assistant-dreaming.js";

// Save-chain steps of the settings page (see docs/settings-pattern.md). Each step
// owns its draft keys, so a retry after a partial save skips finished steps.
const preferenceKeys = ["defaultCwd", "autoResumeInterrupted"];
// The MCP directory setting is one record on the server; either draft key sends both.
const directoryKeys = ["mcpDirectoryEnabled", "mcpDirectoryBaseUrl"];

// A label may be a function: it is read when the bar reports "Partially saved: …",
// after the language step may have switched the UI language.
const labelled = (step, label) =>
  Object.defineProperty(step, "label", {
    enumerable: true,
    get: () => (typeof label === "function" ? label() : label),
  });

/**
 * Blocks the chain before any request while a changed field breaks its constraint
 * (ruling P6). `error(values)` returns the field's message or "". Without `keys` and
 * `label` it never counts as a saved part.
 */
export const fieldCheckStep = ({ id, fields, error }) => ({
  id,
  run: ({ values, changed }) => {
    const message = fields.some((key) => changed.includes(key)) ? error(values) : "";
    if (message) throw new Error(message);
    return {};
  },
});

/** The host capacity the old form allowed (`min=4 max=32`). */
export const capacityRange = { min: 4, max: 32 };
export const capacityInvalid = (value) =>
  !Number.isInteger(value) || value < capacityRange.min || value > capacityRange.max;

/** The UI language: local, cannot fail, applied when the tab is saved. */
export const languageStep = ({ label, apply }) =>
  labelled(
    {
      id: "language",
      keys: ["language"],
      run: async ({ values }) => {
        apply(values.language);
        return {};
      },
    },
    label,
  );

/** PATCH /preferences with only the fields changed in this draft. */
export const preferencesStep = ({
  label,
  save = (body) => api("/preferences", "PATCH", body),
  refresh,
}) =>
  labelled(
    {
      id: "preferences",
      keys: [...preferenceKeys, ...directoryKeys],
      run: async ({ values, changed }) => {
        const body = Object.fromEntries(
          preferenceKeys
            .filter((key) => changed.includes(key))
            .map((key) => [key, values[key]]),
        );
        if (directoryKeys.some((key) => changed.includes(key)))
          body.mcpDirectory = {
            enabled: values.mcpDirectoryEnabled,
            baseUrl: String(values.mcpDirectoryBaseUrl ?? "").trim(),
          };
        const result = await save(body);
        // The preferences are stored; a failed reload of the workspace state only
        // delays the canonical directory and must not report the save as failed.
        try {
          await refresh?.();
        } catch {}
        return result;
      },
    },
    label,
  );

/**
 * PUT /assistant-feature through the shared feature store. The server may answer
 * 200 with `{ enabled: false, error }` when agents cannot start; that is a failure
 * of this step, so the tab stays dirty and the bar says so.
 */
export const featureStep = ({ label, setEnabled, notApplied }) =>
  labelled(
    {
      id: "feature",
      keys: ["agentsEnabled"],
      run: async ({ values }) => {
        const feature = await setEnabled(values.agentsEnabled);
        if (feature && feature.enabled !== values.agentsEnabled)
          throw new Error(notApplied(feature));
        return feature;
      },
    },
    label,
  );

/** PUT /assistant-team-settings with the draft's base revision. */
export const hostCapacityStep = ({ label, save, refresh }) =>
  labelled(
    {
      id: "capacity",
      keys: ["hostMaxConcurrent"],
      resource: "team",
      run: async ({ values, revision }) => {
        const result = await save({
          revision,
          hostMaxConcurrent: values.hostMaxConcurrent,
        });
        try {
          await refresh?.();
        } catch {}
        return result;
      },
    },
    label,
  );

const dreamingConfirmation = "ASSISTANT_DREAMING_MEMORY_CONFIRMATION_REQUIRED";
const dreamingBusy = "ASSISTANT_DREAMING_AGENTS_BUSY";

/**
 * PUT /assistant-dreaming with the draft's base revision. Switching on while permanent
 * agents lack memory asks to confirm turning it on for the agents the server names;
 * agents busy right now are named in the error.
 */
export const dreamingStep = ({ label, save, refresh }) =>
  labelled(
    {
      id: "dreaming",
      keys: ["dreamingEnabled", "dreamingHour", "dreamingTimeZone"],
      resource: "dreaming",
      run: async ({ values, revision, confirmations }) => {
        let result;
        try {
          result = await save({
            enabled: values.dreamingEnabled,
            hour: values.dreamingHour,
            timeZone: values.dreamingTimeZone,
            revision,
            ...confirmations,
          });
        } catch (error) {
          if (error?.code === dreamingBusy && error.agents?.length)
            error.message = assistantDreamingCopy.busy(
              error.agents.map((agent) => agent.name).join(", "),
            );
          throw error;
        }
        try {
          await refresh?.();
        } catch {}
        return result;
      },
      confirmation: (error) =>
        error?.code === dreamingConfirmation
          ? {
              kind: "dreamingMemory",
              flags: { confirmMemory: true },
              data: { agents: error.agents || [] },
            }
          : null,
    },
    label,
  );

/**
 * PUT /operations/releases/channel; the page adopts the returned releases. Changing
 * the channel cancels a running check or stage, so `blocked()` returns a message
 * while a release job runs and the step refuses before sending.
 */
export const updateChannelStep = ({ label, save, onSaved, blocked }) =>
  labelled(
    {
      id: "channel",
      keys: ["updateChannel"],
      run: async ({ values }) => {
        const reason = blocked?.();
        if (reason) throw new Error(reason);
        const result = await save(values.updateChannel);
        onSaved?.(result);
        return result;
      },
    },
    label,
  );
