import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateDirectory } from "../../lib/storage.js";
/** Internal managed profiles retain their native history independently of connection lifetime. */
export function connectionProfile(accounts, { source, connection, provider }) {
  const existing = accounts.accounts.find(
    (account) =>
      account.internal?.kind === "provider-connection" &&
      account.internal.connectionId === connection.id &&
      account.internal.sourceAccountId === source.id &&
      account.tool === source.tool &&
      JSON.stringify(account.provider) === JSON.stringify(provider),
  );
  if (existing) return structuredClone(existing);
  const account = {
    id: randomUUID(),
    name: `${connection.name} · ${source.tool}`,
    tool: source.tool,
    kind: "managed",
    hasSecret: false,
    createdAt: new Date().toISOString(),
    provider,
    internal: {
      kind: "provider-connection",
      connectionId: connection.id,
      sourceAccountId: source.id,
    },
  };
  privateDirectory(path.join(accounts.dataDir, "profiles", account.id));
  accounts.accounts.push(account);
  accounts.save();
  accounts.environment(account.id);
  return structuredClone(account);
}
