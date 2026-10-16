import test from "node:test";
import assert from "node:assert/strict";
import { staysOnEntry } from "../../web/features/accounts/useAccountDraft.js";
import { fieldErrors } from "../../web/features/mcp-servers/field-errors.js";

const entry = { section: "mcp-servers", item: "srv-1", step: "settings" };
const next = (route) => ({ next: { view: "accounts", ...route } });

test("an edit draft stays only on the same entry and the same step", () => {
  assert.equal(staysOnEntry(entry, next(entry)), true);
  assert.equal(staysOnEntry(entry, next({ ...entry, step: "setup" })), false);
  assert.equal(staysOnEntry(entry, next({ ...entry, step: undefined })), false);
  assert.equal(staysOnEntry(entry, next({ ...entry, item: "srv-2" })), false);
  assert.equal(staysOnEntry(entry, { next: { ...entry, view: "chat" } }), false);
  assert.equal(staysOnEntry(entry, {}), false);
});

test("an entry without a step stays on routes without a step", () => {
  const plain = { section: "providers", item: "p-1" };
  assert.equal(staysOnEntry(plain, next(plain)), true);
  assert.equal(staysOnEntry(plain, next({ ...plain, step: "settings" })), false);
});

test("a refused field is named and described; other fields stay plain", () => {
  const { errorId, errorOf, describe } = fieldErrors("form-1", {
    field: "command",
    text: "Not found",
  });
  assert.equal(errorId, "form-1-field-error");
  assert.equal(errorOf("command"), "Not found");
  assert.equal(errorOf("args"), "");
  assert.deepEqual(describe("command"), {
    "aria-invalid": true,
    "aria-describedby": "form-1-field-error",
  });
  assert.deepEqual(describe("args"), {});
  assert.equal(fieldErrors("form-1", null).errorOf("command"), "");
});
