import test from "node:test";
import assert from "node:assert/strict";
import * as de from "../../web/lib/i18n/de/mcp-oauth.js";
import * as en from "../../web/lib/i18n/en/mcp-oauth.js";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { mcpCliErrorCodes } from "../../server/features/mcp-servers/openclaw-mcp-cli.js";
import { providerErrors } from "../../server/features/mcp-servers/mcp-oauth-logins.js";
import {
  authorizationTarget,
  oauthResultText,
  readMcpOAuthResult,
} from "../../web/features/mcp-servers/oauth-result.js";
import { readRoute, routePath } from "../../web/app/routes.js";

// Every reason the callback can carry: provider errors, the CLI's codes, and the
// callback's own ("provider-error", "code-missing", "unavailable", "state-invalid",
// "plain-http-remote").
const reasons = [
  ...providerErrors,
  ...mcpCliErrorCodes,
  "provider-error",
  "code-missing",
  "unavailable",
  "state-invalid",
  "plain-http-remote",
];

test("every callback reason has German and English text", () => {
  for (const catalog of [de.mcpOAuthCopy, en.mcpOAuthCopy])
    for (const reason of reasons)
      assert.ok(Object.hasOwn(catalog.reasons, reason), `${reason} is translated`);
});

test("the callback result survives as route state while the address drops it", () => {
  const route = readRoute(
    new URL("http://localhost/accounts?oauth=error&server=s-1&reason=access_denied"),
  );
  assert.deepEqual(route.mcpOAuth, {
    result: "error",
    serverId: "s-1",
    reason: "access_denied",
  });
  // The old Accounts address lands on Zugänge with the result kept.
  assert.equal(routePath(route), "/connections");
  assert.deepEqual(readMcpOAuthResult("?oauth=maybe&server=s-1"), {});
  assert.deepEqual(readMcpOAuthResult("?oauth=connected&server=../x&reason=x"), {
    mcpOAuth: { result: "connected" },
  });
});

test("result text names the server, the reason and the redirect in use", () => {
  setLanguage("en", { persist: false });
  try {
    const servers = [{ id: "s-1", name: "docs" }];
    assert.equal(
      oauthResultText({ result: "connected", serverId: "s-1" }, servers, ""),
      "Logged in to docs. Agents bound to it can use its tools from their next turn.",
    );
    assert.match(
      oauthResultText(
        { result: "error", serverId: "s-1", reason: "redirect-rejected" },
        servers,
        "https://host.example",
      ),
      /docs failed\. .*https:\/\/host\.example\/api\/mcp-servers\/oauth\/callback/,
    );
    // An expired, used or replaced state names no server.
    const stale = readMcpOAuthResult("?oauth=error&reason=state-invalid").mcpOAuth;
    assert.match(
      oauthResultText(stale, servers, ""),
      /^The OAuth login failed\. This login has expired, was already used or was replaced/,
    );
    assert.match(
      oauthResultText({ result: "error", reason: "constructor" }, [], ""),
      /^The OAuth login failed\. The login could not be completed/,
    );
  } finally {
    setLanguage("de", { persist: false });
  }
});

test("only web addresses are opened for a login", () => {
  assert.equal(
    authorizationTarget("https://auth.example/authorize?state=x"),
    "https://auth.example/authorize?state=x",
  );
  assert.equal(authorizationTarget("javascript:alert(1)"), null);
  assert.equal(authorizationTarget("not a url"), null);
});
