import test from "node:test";
import assert from "node:assert/strict";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

const cases = [
  ["sshNotGranted", 403, "SSH_NOT_GRANTED"],
  ["sshHostUnavailable", 404, "SSH_HOST_UNAVAILABLE"],
  ["sshHostUnavailable", 503, "SSH_HOST_UNAVAILABLE"],
  ["sshRoutineNotTrusted", 403, "SSH_ROUTINE_NOT_TRUSTED"],
  ["sshOriginRefused", 403, "SSH_ORIGIN_REFUSED"],
  ["sshBusy", 429, "SSH_BUSY"],
  ["sshApprovalLimit", 429, "SSH_APPROVAL_LIMIT"],
  ["sshRevoked", 403, "SSH_REVOKED"],
];

test("SSH refusals reach the model as stable codes with fixed English reasons", () => {
  for (const [key, status, code] of cases) {
    const result = toolError(assistantProblem(key, status));
    assert.equal(result.code, code, key);
    assert.equal(result.status, status, key);
    assert.match(result.reason, /\S/, key);
    assert.doesNotMatch(result.reason, /[äöüßÄÖÜ]/, key);
  }
  assert.match(toolError(assistantProblem("sshRoutineNotTrusted", 403)).reason, /result/);
});

test("owner-facing texts and Telegram copy exist in both languages", () => {
  for (const language of ["de", "en"]) {
    const m = serverCatalogs[language].assistants;
    for (const [key] of cases)
      assert.equal(typeof m[key], "string", `${language} ${key}`);
    assert.equal(typeof m.telegramSendersSsh, "string");
    assert.match(m.sshStates.completed(0), /0/);
    assert.match(m.sshTarget("nas-01", "root@nas:22"), /nas-01.*root@nas:22/);
  }
});
