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

const mailCodes = {
  mailNotGranted: "MAIL_NOT_GRANTED",
  mailSendNotGranted: "MAIL_SEND_NOT_GRANTED",
  mailOriginRefused: "MAIL_ORIGIN_REFUSED",
  mailAccountUnavailable: "MAIL_ACCOUNT_UNAVAILABLE",
  mailAuthFailed: "MAIL_AUTH_FAILED",
  mailTlsFailed: "MAIL_TLS_FAILED",
  mailUnreachable: "MAIL_UNREACHABLE",
  mailTimeout: "MAIL_TIMEOUT",
  mailProtocol: "MAIL_PROTOCOL",
  mailNotFound: "MAIL_NOT_FOUND",
  mailNoTrash: "MAIL_NO_TRASH",
  mailNoArchive: "MAIL_NO_ARCHIVE",
  mailNoDrafts: "MAIL_NO_DRAFTS",
  mailAttachmentsUnsupported: "MAIL_ATTACHMENTS_UNSUPPORTED",
  mailApprovalLimit: "MAIL_APPROVAL_LIMIT",
  mailSendLimit: "MAIL_SEND_LIMIT",
  mailRevoked: "MAIL_REVOKED",
  mailQueryEmpty: "MAIL_QUERY_EMPTY",
  mailSearchUnsupported: "MAIL_SEARCH_UNSUPPORTED",
};

test("mail problems carry stable codes, fixed English reasons and owner copy", () => {
  for (const [key, code] of Object.entries(mailCodes)) {
    const error = toolError(assistantProblem(key, 409));
    assert.equal(error.code, code, key);
    assert.equal(error.reason, toolReason(code), key);
    assert.notEqual(error.reason, toolReason("UNAVAILABLE"), key);
    for (const lang of ["de", "en"])
      assert.equal(typeof serverCatalogs[lang].mail[key], "string", `${lang} ${key}`);
  }
  // A connection failure (mail-connection.js) keeps its code without a status.
  const failure = toolError(
    Object.assign(Error("MAIL_AUTH_FAILED"), {
      code: "MAIL_AUTH_FAILED",
      key: "mailAuthFailed",
    }),
  );
  assert.equal(failure.code, "MAIL_AUTH_FAILED");
  // An account refused plaintext before connecting reads as a TLS failure.
  assert.equal(
    toolError(Object.assign(Error("x"), { key: "mailPlaintextRefused" })).code,
    "MAIL_TLS_FAILED",
  );
});
