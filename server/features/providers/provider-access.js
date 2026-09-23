import { serverMessages } from "../../lib/i18n/de.js";
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
      throw problem(serverMessages.providers.invalidAccessSelection);
    const central = body.providerConnectionId !== undefined;
    if (central && body.nativeModelId !== undefined)
      throw problem(serverMessages.providers.nativeOrProviderModel);
    if (!central && body.providerModelId !== undefined)
      throw problem(serverMessages.providers.connectionRequiredForModel);
    const source = this.accounts.get(
      body.accountId ||
        (!central && !login && this.preferences?.get().defaultAccountIds[body.tool]) ||
        (body.tool ? `local-${body.tool}` : undefined),
    );
    if (source.internal) throw problem(serverMessages.accounts.notFound, 404);
    if (body.tool !== undefined && source.tool !== body.tool)
      throw problem(serverMessages.providers.nativeAccountToolMismatch);
    if (!central) return { account: source };
    if (login || source.tool === "shell")
      throw problem(serverMessages.providers.connectionRequiresWorkSession);
    const connection = this.connections.get(body.providerConnectionId);
    if (!connection.hasSecret)
      throw problem(serverMessages.providers.apiKeyRequiredForSession, 409);
    if (!connection.tools.includes(source.tool))
      throw problem(serverMessages.providers.connectionToolUnsupported);
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
