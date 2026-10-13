import { assistantApi } from "./assistant-api.js";

/**
 * Save-chain steps for agent settings (docs/settings-pattern.md). Each sends the
 * revision the draft started from, never the latest one from props, so a change made
 * elsewhere is reported as a conflict instead of being overwritten.
 */
export function assistantPatchStep({
  assistantId,
  label,
  keys,
  body,
  update = assistantApi.update,
}) {
  return {
    id: "assistant",
    label,
    keys,
    resource: "assistant",
    run: ({ values, revision, confirmations }) =>
      update(assistantId, { ...body(values), revision, ...confirmations }),
  };
}

export function assistantWorkStep({
  assistantId,
  label,
  keys,
  access,
  team,
  save = assistantApi.saveWork,
}) {
  return {
    id: "work",
    label,
    keys,
    run: ({ values, revisions }) =>
      save(assistantId, {
        ...(access ? { access: { revision: revisions.access, ...access(values) } } : {}),
        ...(team ? { team: { revision: revisions.team, ...team(values) } } : {}),
      }),
    revisions: (result) => ({
      access: result.access.revision,
      team: result.team.revision,
    }),
  };
}
