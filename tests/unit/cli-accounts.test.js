import test from "node:test";
import assert from "node:assert/strict";
import { routePath } from "../../web/app/routes.js";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  cliAccountRoute,
  cliAccountTitle,
  isDefaultAccount,
  nativeAccounts,
  resolveCliAccount,
} from "../../web/features/coding/accounts/cli-accounts.js";

const accounts = [
  { id: "local-codex", name: "Local codex", tool: "codex", kind: "local" },
  { id: "managed-1", name: "Work", tool: "codex", kind: "managed" },
  { id: "local-shell", name: "Shell", tool: "shell" },
];

test("Coding › Accounts lists the native CLI accounts without the shell", () => {
  assert.deepEqual(
    nativeAccounts(accounts).map((account) => account.id),
    ["local-codex", "managed-1"],
  );
  assert.equal(nativeAccounts(null), null);
});

test("an account address resolves to its entry, the form, loading or missing", () => {
  assert.equal(resolveCliAccount("", accounts), null);
  assert.deepEqual(resolveCliAccount("managed-1", accounts), {
    kind: "cli-account",
    section: "cli",
    item: "managed-1",
    record: accounts[1],
  });
  assert.equal(resolveCliAccount("new", null).kind, "cli-new");
  assert.equal(resolveCliAccount("managed-1", null).kind, "loading");
  assert.equal(resolveCliAccount("local-shell", accounts).kind, "missing");
  assert.equal(resolveCliAccount("gone", accounts).kind, "missing");
});

test("account routes, titles and the default account", () => {
  assert.equal(routePath(cliAccountRoute()), "/coding/clis?tab=accounts");
  assert.equal(
    routePath(cliAccountRoute("managed-1")),
    "/coding/clis?tab=accounts&item=managed-1",
  );
  setLanguage("en");
  assert.equal(cliAccountTitle(resolveCliAccount("new", accounts)), "Add account");
  setLanguage("de");
  assert.equal(cliAccountTitle(resolveCliAccount("managed-1", accounts)), "Work");
  assert.equal(cliAccountTitle(null), "");
  assert.equal(isDefaultAccount({}, accounts[0]), true);
  assert.equal(isDefaultAccount({}, accounts[1]), false);
  assert.equal(
    isDefaultAccount({ defaultAccountIds: { codex: "managed-1" } }, accounts[1]),
    true,
  );
});
