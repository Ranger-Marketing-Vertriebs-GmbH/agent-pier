import { assistantProblem, textValue } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";

const defaultLimit = 50;
const maxLimit = 200;

/** The checked input of agentpier_team_models: an optional query and limit. */
export function memberModelsInput(input) {
  exact(input, ["query", "limit"]);
  const query = input.query === undefined ? "" : textValue(input.query, 100, true).trim();
  const limit = "limit" in input ? input.limit : defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit)
    throw assistantProblem("invalid");
  return { query: query.toLowerCase(), limit };
}

const entry = (connection, row, extra) => ({
  connectionId: connection.id,
  connection: connection.shown,
  provider: connection.providerId,
  modelId: row.modelId,
  label: row.label || row.modelId,
  contextTokens: row.contextTokens ?? null,
  outputTokens: row.outputTokens ?? null,
  reasoning: null,
  imageInput: null,
  pricing: null,
  ...extra,
});

/**
 * Every model a lead can give its members, from the connections the owner can use
 * now: ChatGPT accounts and endpoint connections with their own model lists, and
 * OpenRouter connections with the provider catalog (the only source of prices).
 */
function available(models, catalog) {
  let openRouter;
  const connections = models.listCapabilities();
  // A ChatGPT account's name can be its e-mail, which the lead (and the senders of
  // its turns) must not read: "ChatGPT", with a piece of the hashed id when several.
  const accounts = connections.filter((c) => c.providerId === "openai-chatgpt").length;
  const shown = (c) =>
    c.providerId !== "openai-chatgpt"
      ? c.name
      : accounts > 1
        ? `ChatGPT ${c.id.replace(/^openclaw:/, "").slice(0, 6)}`
        : "ChatGPT";
  return connections
    .filter((connection) => connection.available === true)
    .map((connection) => ({ ...connection, shown: shown(connection) }))
    .flatMap((connection) => {
      if (connection.providerId === "openrouter") {
        openRouter ??= catalog.list({ providerId: "openrouter" });
        return openRouter.map((row) =>
          entry(connection, row, {
            reasoning: row.capabilities?.reasoning ?? null,
            imageInput: row.capabilities?.imageInput ?? null,
            pricing: row.pricing
              ? {
                  inputPerMTok: row.pricing.inputPerMTok ?? null,
                  outputPerMTok: row.pricing.outputPerMTok ?? null,
                }
              : null,
          }),
        );
      }
      return (connection.models || []).map((row) =>
        entry(connection, row, {
          imageInput: models.imageInput({
            connectionId: connection.id,
            modelId: row.modelId,
          }),
        }),
      );
    })
    .sort(
      (a, b) =>
        a.connection.localeCompare(b.connection) ||
        a.connectionId.localeCompare(b.connectionId) ||
        a.label.localeCompare(b.label) ||
        a.modelId.localeCompare(b.modelId),
    );
}

// A model as the lead reads it: its ids, and its names and price while offered.
function described(model, all) {
  if (!model) return null;
  const { connectionId, modelId } = model;
  const known = all.find((m) => m.connectionId === connectionId && m.modelId === modelId);
  return known
    ? {
        connectionId,
        modelId,
        connection: known.connection,
        label: known.label,
        pricing: known.pricing,
      }
    : { connectionId, modelId };
}

/**
 * What agentpier_team_models returns: the matching models (sorted by connection,
 * then label; at most `limit`), how many match, and the model the lead and each of
 * its `members` ({ memberId, name, model }, the effective model) run on now.
 */
export function listMemberModels({
  models,
  catalog,
  lead,
  members = [],
  query = "",
  limit = defaultLimit,
}) {
  const all = available(models, catalog);
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? all.filter((m) =>
        [m.modelId, m.label, m.connection].some((text) =>
          text.toLowerCase().includes(needle),
        ),
      )
    : all;
  return {
    models: matches.slice(0, Math.min(limit, maxLimit)),
    total: matches.length,
    current: {
      lead: described(lead?.model, all),
      members: members.map(({ memberId, name, model }) => ({
        memberId,
        name,
        model: described(model, all),
      })),
    },
  };
}

/** A lead's model choice as given: exactly a connectionId and a modelId. */
export function memberModelInput(model) {
  exact(model, ["connectionId", "modelId"]);
  return {
    connectionId: textValue(model.connectionId, 200),
    modelId: textValue(model.modelId, 256),
  };
}

/**
 * The model a lead assigns, checked as the runtime would use it: models.resolve()
 * refuses one the owner cannot run now (a connection without its key, a signed-out
 * ChatGPT account, an endpoint model not in its list). The lease is given back at
 * once; the member's next turn takes its own. Returns the ids and the owner's names.
 */
export async function validateMemberModel(models, { connectionId, modelId }) {
  let lease;
  try {
    lease = await models.resolve({ connectionId, modelId });
  } catch (error) {
    // An unknown connection is a model the lead cannot give, like any other.
    throw error?.key ? error : assistantProblem("provider");
  }
  lease.release?.();
  return { connectionId, modelId, display: { ...lease.display } };
}

/**
 * The proposed members with each lead-chosen `model` checked like
 * validateMemberModel, plus the owner's names for it (`modelLabel`) for the approval
 * card. A label the lead sent itself is dropped; one unusable model refuses them all.
 */
export function proposedMemberModels(models, members) {
  if (!Array.isArray(members)) return members;
  return Promise.all(
    members.map(async (member) => {
      if (!member || typeof member !== "object") return member;
      const { model, modelLabel: _forged, ...rest } = member;
      if (!("model" in member)) return rest;
      const chosen = await validateMemberModel(models, memberModelInput(model));
      return {
        ...rest,
        model: { connectionId: chosen.connectionId, modelId: chosen.modelId },
        modelLabel: {
          connection: String(chosen.display.connection ?? chosen.connectionId),
          model: String(chosen.display.model ?? chosen.modelId),
        },
      };
    }),
  );
}

/** A proposal draft's model as TeamStore keeps it: the ids and the owner's names. */
export const draftModel = (member) =>
  member.model === undefined
    ? {}
    : {
        model: memberModelInput(member.model),
        modelLabel: {
          connection: textValue(member.modelLabel?.connection, 200),
          model: textValue(member.modelLabel?.model, 256),
        },
      };
