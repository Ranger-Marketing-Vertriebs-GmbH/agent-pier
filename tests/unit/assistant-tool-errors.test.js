import test from "node:test";
import assert from "node:assert/strict";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import { toolError, toolReason } from "../../server/features/assistants/tool-errors.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";
import { mailError } from "../../server/features/mail/mail-connection.js";

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
  mailApprovalLimit: "MAIL_APPROVAL_LIMIT",
  mailSendLimit: "MAIL_SEND_LIMIT",
  mailRevoked: "MAIL_REVOKED",
  mailQueryEmpty: "MAIL_QUERY_EMPTY",
  mailSearchUnsupported: "MAIL_SEARCH_UNSUPPORTED",
  mailMoveUnsupported: "MAIL_MOVE_UNSUPPORTED",
  mailDraftUnsupported: "MAIL_DRAFT_UNSUPPORTED",
  mailAttachmentTooLarge: "MAIL_ATTACHMENT_TOO_LARGE",
  mailDraftChanged: "MAIL_DRAFT_CHANGED",
  mailTextUnsupported: "MAIL_TEXT_UNSUPPORTED",
  mailTextFailed: "MAIL_TEXT_FAILED",
  mailBusy: "MAIL_BUSY",
  mailSourceRefused: "MAIL_SOURCE_REFUSED",
  mailSourceNotFound: "MAIL_SOURCE_NOT_FOUND",
  mailSourceEmpty: "MAIL_SOURCE_EMPTY",
  mailSaveRefused: "MAIL_SAVE_REFUSED",
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

test("the attachment mail errors keep their codes and the source problems their status", () => {
  // Raised in the mail layer (mail-connection.js mailError): a code and a key only.
  for (const code of [
    "MAIL_ATTACHMENT_TOO_LARGE",
    "MAIL_DRAFT_CHANGED",
    "MAIL_TEXT_UNSUPPORTED",
    "MAIL_TEXT_FAILED",
    "MAIL_BUSY",
  ]) {
    const error = mailError(code);
    assert.equal(typeof error.key, "string", code);
    assert.equal(mailCodes[error.key], code);
    const tool = toolError(error);
    assert.equal(tool.code, code);
    assert.equal(tool.reason, toolReason(code));
  }
  // Raised by AgentPier's file checks (assistantProblem) with their HTTP status.
  for (const [key, status, code] of [
    ["mailSourceRefused", 403, "MAIL_SOURCE_REFUSED"],
    ["mailSourceNotFound", 404, "MAIL_SOURCE_NOT_FOUND"],
    ["mailSourceEmpty", 400, "MAIL_SOURCE_EMPTY"],
    ["mailSaveRefused", 403, "MAIL_SAVE_REFUSED"],
  ]) {
    const tool = toolError(assistantProblem(key, status));
    assert.equal(tool.code, code, key);
    assert.equal(tool.status, status, key);
  }
  // Each new reason tells the agent what to do next.
  for (const code of Object.values(mailCodes).slice(-8)) {
    assert.match(toolReason(code), /\b(try|tell the owner)\b/i, code);
    assert.notEqual(toolReason(code), toolReason("UNAVAILABLE"), code);
  }
});

test("project tool problems carry their stable codes and English reasons", () => {
  for (const [key, status, code] of [
    ["projectNameInvalid", 400, "PROJECT_NAME_INVALID"],
    ["projectExists", 409, "PROJECT_EXISTS"],
    ["projectCreateLimit", 429, "PROJECT_CREATE_LIMIT"],
    ["projectOwnerOnly", 403, "PROJECT_OWNER_ONLY"],
    ["projectNotCreatedByYou", 403, "PROJECT_NOT_CREATED_BY_YOU"],
    ["projectNotEligible", 403, "PROJECT_NOT_ELIGIBLE"],
    ["projectFolderUnavailable", 409, "PROJECT_FOLDER_UNAVAILABLE"],
  ]) {
    const e = toolError(assistantProblem(key, status));
    assert.equal(e.code, code, key);
    assert.equal(e.reason, toolReason(code), key);
    assert.notEqual(e.reason, toolReason("UNAVAILABLE"), key);
    // The limit copy names the cap (agent-project-rules.js projectCreateCaps).
    for (const lang of ["de", "en"])
      assert.equal(
        typeof serverCatalogs[lang].agentProjects[key],
        key === "projectCreateLimit" ? "function" : "string",
        key,
      );
  }
});
