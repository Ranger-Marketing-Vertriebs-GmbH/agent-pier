import test from "node:test";
import assert from "node:assert/strict";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import { toolError, toolReason } from "../../server/features/assistants/tool-errors.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

const sessionCodes = {
  sessionsNotEnabled: ["SESSIONS_NOT_ENABLED", 403],
  grantRevoked: ["GRANT_REVOKED", 403],
  sessionLimit: ["SESSION_LIMIT", 409],
  promptAnswered: ["PROMPT_ANSWERED", 409],
  sessionRunning: ["SESSION_RUNNING", 409],
  worktreeDirty: ["WORKTREE_DIRTY", 409],
  worktreeNotMerged: ["WORKTREE_NOT_MERGED", 409],
  noRepository: ["NO_REPOSITORY", 409],
};

test("coding session problems carry stable codes and fixed English reasons", () => {
  assert.equal(toolError(assistantProblem("grantRevoked", 403)).code, "GRANT_REVOKED");
  for (const [key, [code, status]] of Object.entries(sessionCodes)) {
    const error = toolError(assistantProblem(key, status));
    assert.equal(error.code, code, key);
    assert.equal(error.status, status, key);
    assert.equal(error.reason, toolReason(code), key);
    assert.notEqual(error.reason, toolReason("UNAVAILABLE"), key);
    // Owner-facing copy exists in both languages.
    for (const lang of ["de", "en"])
      assert.equal(
        typeof serverCatalogs[lang].agentCodingSessions[key],
        "string",
        `${lang} ${key}`,
      );
  }
});
