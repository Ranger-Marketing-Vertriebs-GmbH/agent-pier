import test from "node:test";
import assert from "node:assert/strict";
import { directoryProblem } from "../../server/features/mcp-directory/directory-errors.js";
import { messageIdentity } from "../../server/lib/i18n/message-identity.js";

test("each code has its status and a stable message key", () => {
  for (const [code, status, key] of [
    ["MCP_DIRECTORY_DISABLED", 409, "mcpDirectory.disabled"],
    ["MCP_DIRECTORY_UNAVAILABLE", 503, "mcpDirectory.unavailable"],
    ["MCP_DIRECTORY_MISCONFIGURED", 502, "mcpDirectory.misconfigured"],
    ["MCP_DIRECTORY_NOT_FOUND", 404, "mcpDirectory.notFound"],
    ["MCP_DIRECTORY_INVALID", 502, "mcpDirectory.invalid"],
    ["MCP_DIRECTORY_INVALID_REQUEST", 400, "mcpDirectory.invalidRequest"],
  ]) {
    const error = directoryProblem(code);
    assert.deepEqual([error.code, error.status], [code, status]);
    assert.equal(messageIdentity(error.message).messageKey, key);
  }
  assert.throws(() => directoryProblem("NOPE"));
});
