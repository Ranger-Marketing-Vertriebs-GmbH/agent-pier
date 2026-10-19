import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  memberGrantDetail,
  memberGrantName,
} from "../../web/features/assistants/lead-shares.js";
import { logText } from "../../web/features/assistants/member-grants.js";

const at = "2026-10-19T10:00:00.000Z";

test("a task member's grants read as they count now, in English and German", () => {
  setLanguage("en", { persist: false });
  assert.equal(
    memberGrantDetail({ kind: "project", live: { folder: "read" } }),
    "Task-bound member · Folder: read",
  );
  assert.equal(
    memberGrantDetail({ kind: "mcp", live: { bound: false } }),
    "Task-bound member · Not in effect: the lead agent does not hold it right now",
  );
  assert.equal(
    memberGrantDetail({ kind: "shell", live: { shell: "off" } }),
    "Task-bound member · Not in effect: the lead agent does not hold it right now",
  );
  assert.equal(
    memberGrantDetail({ kind: "ssh", live: { ssh: true } }),
    "Task-bound member · SSH on the lead agent's hosts",
  );
  assert.equal(memberGrantName({ kind: "ssh" }), "SSH");
  assert.equal(memberGrantName({ kind: "mcp", serverName: "docs" }), "MCP server docs");
  setLanguage("de", { persist: false });
  assert.equal(
    memberGrantDetail({ kind: "coding", live: { coding: true } }),
    "Auftragsgebundenes Mitglied · Coding-Aufträge über den leitenden Agenten",
  );
});

test("the owner's own revocation reads apart from switching shell and SSH off", () => {
  setLanguage("en", { persist: false });
  const direct = logText({ at, by: "owner", direct: true, revoked: ["ssh"] });
  const setting = logText({ at, by: "owner", revoked: ["ssh"] });
  assert.match(direct, /you revoked/);
  assert.match(setting, /switching off shell and SSH/);
  setLanguage("de", { persist: false });
  assert.match(
    logText({ at, by: "owner", direct: true, revoked: ["ssh"] }),
    /widerrufen/,
  );
});
