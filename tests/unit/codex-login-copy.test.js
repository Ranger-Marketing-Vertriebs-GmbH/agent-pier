import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  brokerUsable,
  codexResultText,
  failureReason,
  openBlankTab,
} from "../../web/features/mcp-servers/codex-login.js";
import { readMcpOAuthResult } from "../../web/features/mcp-servers/oauth-result.js";
import { providerErrors } from "../../server/features/mcp-servers/mcp-oauth-logins.js";

// Every reason a brokered Codex login can end with (codex-mcp-logins.js and the
// callback route), each with its own text rather than the generic one.
const reasons = [
  ...providerErrors,
  "provider-error",
  "cli-failed",
  "cli-timeout",
  "expired",
  "state-invalid",
  "unavailable",
  "plain-http-remote",
];

test("every Codex login reason reads as its own sentence in both languages", () => {
  for (const language of ["en", "de"]) {
    setLanguage(language);
    const generic = failureReason("nonsense");
    for (const reason of reasons) {
      const text = failureReason(reason);
      assert.equal(typeof text, "string");
      assert.notEqual(text, generic, `${language}: ${reason}`);
    }
  }
  setLanguage("en");
});

test("a Codex callback result keeps its account and CLI", () => {
  assert.deepEqual(
    readMcpOAuthResult("?oauth=connected&server=s1&cli=codex&account=a-1"),
    { mcpOAuth: { result: "connected", cli: "codex", accountId: "a-1", serverId: "s1" } },
  );
  // Another CLI or a malformed account is no Codex result.
  assert.deepEqual(readMcpOAuthResult("?oauth=connected&server=s1&cli=x&account=a-1"), {
    mcpOAuth: { result: "connected", serverId: "s1" },
  });
  assert.deepEqual(readMcpOAuthResult("?oauth=error&cli=codex&account=../x"), {
    mcpOAuth: { result: "error" },
  });
});

test("the result names the account and the server", () => {
  setLanguage("en");
  const servers = [
    {
      id: "s1",
      name: "docs",
      cliStatus: {
        codex: { oauth: { accounts: [{ id: "a1", name: "Work", state: "connected" }] } },
      },
    },
  ];
  assert.equal(
    codexResultText(
      { result: "connected", cli: "codex", serverId: "s1", accountId: "a1" },
      servers,
    ),
    "The Codex account Work is logged in to docs. New sessions of this account can use its tools.",
  );
  assert.equal(
    codexResultText(
      {
        result: "error",
        cli: "codex",
        serverId: "s1",
        accountId: "gone",
        reason: "access_denied",
      },
      servers,
    ),
    "The login of the Codex account (removed) to docs failed. Access was denied at the provider.",
  );
});

test("logins start only from HTTPS or the AgentPier host", () => {
  assert.equal(brokerUsable({ protocol: "https:", hostname: "pier.ts.net" }), true);
  for (const hostname of ["127.0.0.1", "localhost", "[::1]"])
    assert.equal(brokerUsable({ protocol: "http:", hostname }), true);
  assert.equal(brokerUsable({ protocol: "http:", hostname: "192.168.1.5" }), false);
});

test("the login tab is cut off from AgentPier", () => {
  const tab = { opener: "agentpier" };
  assert.equal(
    openBlankTab((url, target) => {
      assert.deepEqual([url, target], ["", "_blank"]);
      return tab;
    }),
    tab,
  );
  assert.equal(tab.opener, null);
  assert.equal(
    openBlankTab(() => null),
    null,
  );
});
