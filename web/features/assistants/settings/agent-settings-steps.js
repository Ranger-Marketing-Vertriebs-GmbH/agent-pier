import { assistantApi } from "../assistant-api.js";
import { assistantPatchStep } from "../assistant-save-steps.js";
import { confirmationRequest } from "../../../lib/settings/save-chain.js";
import { restartRequired } from "../../provider-connections/restart-confirmation.js";
import {
  accessKeys,
  capabilityFormKeys,
  capabilityPatch,
  channelKeys,
  channelPatch,
  createInput,
  heartbeatKeys,
  heartbeatPatch,
  profileKeys,
  profilePatch,
  teamKeys,
  workBody,
} from "./agent-settings-fields.js";

// Save-chain steps of the agent tabs (docs/settings-pattern.md). Every step sends the
// revision the draft started from, so a change made elsewhere comes back as a 409.
export const profileStep = ({ assistantId, label, update, followsLead = false }) =>
  assistantPatchStep({
    assistantId,
    label,
    keys: profileKeys,
    body: (values) => profilePatch(values, { followsLead }),
    update,
  });

export const capabilityStep = ({ assistant, label, update = assistantApi.update }) => ({
  id: "assistant",
  label,
  keys: capabilityFormKeys,
  resource: "assistant",
  run: ({ values, base, revision, confirmations }) =>
    update(assistant.id, {
      ...capabilityPatch({ values, base, assistant }),
      revision,
      ...confirmations,
    }),
});

export const heartbeatStep = ({ assistant, label, update }) =>
  assistantPatchStep({
    assistantId: assistant.id,
    label,
    keys: heartbeatKeys,
    body: (values) => heartbeatPatch(values, assistant),
    update,
  });

export const channelStep = ({
  channelId,
  label,
  updateChannel = assistantApi.updateChannel,
}) => ({
  id: "channel",
  label,
  keys: channelKeys,
  resource: "channel",
  run: ({ values, base, revision }) =>
    updateChannel(channelId, { ...channelPatch({ values, base }), revision }),
});

export const workStep = ({
  assistantId,
  label,
  withTeam,
  save = assistantApi.saveWork,
}) => ({
  id: "work",
  label,
  keys: withTeam ? [...accessKeys, ...teamKeys] : accessKeys,
  run: ({ values, changed, revisions }) =>
    save(assistantId, workBody({ values, changed, revisions, withTeam })),
  revisions: (result) => ({
    ...(result?.access ? { access: result.access.revision } : {}),
    ...(result?.team ? { team: result.team.revision } : {}),
  }),
});

// A new agent has no running service to restart for: that request is reported as is.
export const createStep = ({ label, create = assistantApi.create }) => ({
  id: "create",
  label,
  run: ({ values, confirmations }) =>
    create({ ...createInput(values), ...confirmations }),
  confirmation: (error) => (restartRequired(error) ? null : confirmationRequest(error)),
});

export const memoryStep = ({
  assistantId,
  name,
  file,
  label,
  saveMemory = assistantApi.saveMemory,
}) => ({
  id: "memory",
  label,
  keys: ["content"],
  run: ({ values }) =>
    saveMemory(assistantId, {
      name,
      content: values.content,
      ...(file.missing ? { expectedMissing: true } : { expectedHash: file.hash }),
    }),
});
