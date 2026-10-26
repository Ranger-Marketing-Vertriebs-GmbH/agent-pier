import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { codingRoute } from "../routes.js";

// Coding › Accounts: native CLI accounts, /coding/clis?tab=accounts[&item=<id|new>].
// Entries keep the former Accounts section name "cli" so drafts and "Used by" read
// them as before.
export const cliAccountRoute = (item, fields = {}) =>
  codingRoute("accounts", { ...(item ? { item } : {}), ...fields });

/** The native accounts the tab lists: every CLI account except the shell. */
export const nativeAccounts = (accounts) =>
  Array.isArray(accounts) ? accounts.filter((account) => account.tool !== "shell") : null;

/**
 * The entry an address shows: null for the list, `loading` while the accounts are
 * unknown, `missing` for an id that does not exist (the tab returns to the list).
 */
export function resolveCliAccount(item, accounts) {
  if (!item) return null;
  const at = (kind, record = null) => ({ kind, section: "cli", item, record });
  if (item === "new") return at("cli-new");
  const list = nativeAccounts(accounts);
  if (!list) return at("loading");
  const record = list.find((account) => account.id === item);
  return record ? at("cli-account", record) : at("missing");
}

export const cliAccountTitle = (entry) =>
  entry?.kind === "cli-account"
    ? entry.record.name
    : entry?.kind === "cli-new"
      ? commonCopy.addAccount
      : "";

/** The default account of a CLI: the chosen one, else its local profile. */
export const isDefaultAccount = (state, account) =>
  (state.defaultAccountIds?.[account.tool] || `local-${account.tool}`) === account.id;
