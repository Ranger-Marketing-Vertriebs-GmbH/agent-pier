import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { marketplaceRow, namePattern, object, pluginRow } from "./plugin-schema.js";

export const remoteMarketplace = "openai-curated-remote";
const copy = serverMessages.plugins;
export function catalogAccount(store, ctx, selected) {
  if (
    selected !== undefined &&
    (ctx.tool !== "codex" ||
      typeof selected !== "string" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(selected))
  )
    throw problem(copy.invalidCatalogAccount);
  if (ctx.tool !== "codex") return null;
  const account = store.accounts.get(selected ?? ctx.id);
  if (account.tool !== "codex") throw problem(copy.invalidCatalogAccount);
  return store.context(account.id, { catalog: true });
}
export function catalogMetadata(store, ctx) {
  return {
    catalogAccountId: ctx.id,
    catalogAccounts: store.accounts
      .list()
      .filter((account) => account.tool === "codex")
      .map(({ id, name }) => ({ id, name })),
    catalogReason: null,
    catalogReasonCode: null,
  };
}
function rows(list) {
  if (!object(list) || !Array.isArray(list.installed) || !Array.isArray(list.available))
    throw problem(copy.unsupportedPluginList, 409);
  return {
    installed: list.installed.map((item) => pluginRow(item, "codex", true)),
    catalog: list.available.map((item) => pluginRow(item, "codex", false)),
  };
}
const isRemote = (item) => item.marketplace === remoteMarketplace;

/** Account authentication is used only for the native remote catalog and its state. */
export async function codexInventory(store, shared, selected) {
  let base,
    localFailure = false;
  try {
    base = await store.nativeInventory(shared);
  } catch (error) {
    if (store.closed || ![409, 502, 503].includes(error.status)) throw error;
    // Remote catalog errors must not hide configured local marketplaces.
    const markets = await store.json(shared, ["plugin", "marketplace", "list", "--json"]);
    const entries = Array.isArray(markets) ? markets : markets?.marketplaces;
    if (!Array.isArray(entries)) throw error;
    base = store.empty(shared);
    base.marketplaces = entries.map((entry) => marketplaceRow(entry, "codex"));
    for (const market of base.marketplaces.filter(
      (market) => namePattern.test(market.name) && market.name !== remoteMarketplace,
    )) {
      const local = rows(
        await store.json(shared, [
          "plugin",
          "list",
          "--json",
          "--available",
          "--marketplace",
          market.name,
        ]),
      );
      base.installed.push(...local.installed);
      base.catalog.push(...local.catalog);
    }
    base.capabilities = {
      marketplaces: true,
      enable: false,
      update: false,
      install: true,
    };
    localFailure = true;
  }
  const result = { ...base, ...catalogMetadata(store, selected) };
  let remote = selected.id === shared.id && !localFailure ? base : null;
  if (!remote && selected.command) {
    try {
      remote = rows(
        await store.json(selected, [
          "plugin",
          "list",
          "--json",
          "--available",
          "--marketplace",
          remoteMarketplace,
        ]),
      );
    } catch (error) {
      if (store.closed || ![409, 502, 503].includes(error.status)) throw error;
      result.catalogReason = copy.remoteCatalogUnavailable;
      result.catalogReasonCode = "unavailable";
    }
  }
  result.installed = [
    ...base.installed.filter((item) => !isRemote(item)),
    ...(remote?.installed || []).filter(isRemote),
  ];
  const installed = new Set(result.installed.map((item) => item.id));
  result.catalog = [
    ...base.catalog.filter((item) => !isRemote(item)),
    ...(remote?.catalog || []).filter(isRemote),
  ].map((item) => ({ ...item, installed: installed.has(item.id) }));
  const implicit = new Set([
    remoteMarketplace,
    ...result.installed.map((item) => item.marketplace),
    ...result.catalog.map((item) => item.marketplace),
  ]);
  result.marketplaces = base.marketplaces.filter(
    (market) => market.name !== remoteMarketplace,
  );
  for (const name of implicit) {
    if (
      !namePattern.test(name) ||
      result.marketplaces.some((market) => market.name === name)
    )
      continue;
    result.marketplaces.push({
      name,
      builtin: true,
      source:
        name === remoteMarketplace
          ? copy.defaultCatalogSource
          : copy.nativeMarketplaceSource,
      removable: false,
      updatable: false,
    });
  }
  if (
    !(remote?.catalog || []).some(isRemote) &&
    !(remote?.installed || []).some(isRemote)
  ) {
    result.catalogReason ||= copy.remoteCatalogEmpty;
    result.catalogReasonCode ||= "empty";
  }
  return result;
}
