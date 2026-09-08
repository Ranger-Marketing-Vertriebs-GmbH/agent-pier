import { problem } from "../../lib/storage.js";
import { validateProviderSelection } from "./provider-definitions.js";
export class ProviderAccess {
  constructor({ accounts, connections, providerCatalog, preferences }) {
    this.preferences = preferences;
    this.accounts = accounts;
    this.connections = connections;
    this.catalog = providerCatalog;
  }
  resolve(body, { login = false } = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw problem("Invalid session access selection.");
    const central = body.providerConnectionId !== undefined;
    if (central && body.nativeModelId !== undefined)
      throw problem("Choose either a native model or a provider model.");
    if (!central && body.providerModelId !== undefined)
      throw problem("Select a provider connection for the provider model.");
    const source = this.accounts.get(
      body.accountId ||
        (!central && !login && this.preferences?.get().defaultAccountIds[body.tool]) ||
        (body.tool ? `local-${body.tool}` : undefined),
    );
    if (source.internal) throw problem("Account not found.", 404);
    if (body.tool !== undefined && source.tool !== body.tool)
      throw problem("The native account does not belong to the selected CLI.");
    if (!central) return { account: source };
    if (login || source.tool === "shell")
      throw problem("Provider connections require a coding work session.");
    const connection = this.connections.get(body.providerConnectionId);
    if (!connection.hasSecret)
      throw problem("Add a provider API key before starting this session.", 409);
    if (!connection.tools.includes(source.tool))
      throw problem(
        "This connection does not support the selected CLI or lacks declared Responses API access.",
      );
    const provider = validateProviderSelection(
      {
        id: connection.providerId,
        modelId: body.providerModelId,
        ...(source.tool === "codex" && connection.providerId !== "openrouter"
          ? { responsesAccess: connection.responsesAccess }
          : {}),
      },
      source.tool,
      this.catalog,
    );
    const account = this.accounts.connectionProfile({ source, connection, provider });
    return {
      account,
      selection: {
        providerConnectionId: connection.id,
        providerConnectionName: connection.name,
        providerId: connection.providerId,
        providerModelId: provider.modelId,
        sourceAccountId: source.id,
      },
    };
  }
}
