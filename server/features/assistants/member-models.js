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
  connection: connection.name,
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
  return models
    .listCapabilities()
    .filter((connection) => connection.available === true)
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
