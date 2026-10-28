import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { validDirectoryName } from "../../server/lib/directories.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  projectCreateCaps,
  projectCreateLimit,
  projectName,
} from "../../server/features/assistants/agent-project-rules.js";
import { mayCreateProjects } from "../../server/features/assistants/goal-turns.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";

const throwsKey = (run, key) => {
  try {
    run();
  } catch (error) {
    return error.key === key;
  }
  return false;
};

test("project names follow createDirectory's rules and refuse a leading dot", () => {
  for (const ok of ["Shop", "my project", "Ünïcödé", "a".repeat(255)])
    assert.equal(projectName(ok), ok);
  for (const bad of [
    "",
    " x",
    "x ",
    ".",
    "..",
    ".hidden",
    "a/b",
    "a\\b",
    "a\nb",
    "a\x00b",
    "\x00",
    "a\x1fb",
    "\x1f",
    "a\x7fb",
    "ü".repeat(128),
    42,
    null,
  ])
    assert.throws(
      () => projectName(bad),
      (e) => e.key === "projectNameInvalid" && e.status === 400,
    );
});

test("every name createDirectory accepts without a leading dot is a project name", () =>
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (name) =>
      validDirectoryName(name) && !name.startsWith(".")
        ? projectName(name) === name
        : throwsKey(() => projectName(name), "projectNameInvalid"),
    ),
  ));

test("own agents and leads may create projects; members, user agents, archived and sender-facing agents may not", () => {
  assert.equal(mayCreateProjects({ id: "a" }), true);
  assert.equal(mayCreateProjects({ id: "a", archivedAt: "x" }), false);
  assert.equal(
    mayCreateProjects({ id: "a", teamMemberId: "m", lifetime: "permanent" }),
    false,
  );
  assert.equal(mayCreateProjects({ id: "a", teamMemberId: "m" }), false);
  // isUserAgent (user-access.js) is true for any agent with a userAccess record.
  assert.equal(mayCreateProjects({ id: "a", userAccess: { mode: "shared" } }), false);
  assert.equal(mayCreateProjects({ id: "a" }, true), false);
  assert.equal(mayCreateProjects(null), false);
  assert.equal(mayCreateProjects(undefined), false);
});

test("a real lead qualifies; its own members do not", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-project-rules-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const model = { connectionId: "c", modelId: "m" };
  const lead = store.createAssistant({ name: "Lead", instructions: "Plan", model });
  const member = (lifetime) =>
    store.reserveMember({
      id: crypto.randomUUID(),
      parent: lead.id,
      assignment: { name: `Scout ${lifetime}`, role: "Research", assignment: "Look" },
      snapshot: store.getAssistant(lead.id),
      teamId: "team-1",
      lifetime,
    });
  const task = member("task"),
    permanent = member("permanent");
  assert.equal(mayCreateProjects(store.getAssistant(lead.id)), true);
  assert.equal(mayCreateProjects(store.getAssistant(task.id)), false);
  assert.equal(mayCreateProjects(store.getAssistant(permanent.id)), false);
  assert.equal(mayCreateProjects(store.getAssistant(lead.id), true), false);
  store.setArchived(lead.id, lead.revision, "2026-10-28T12:00:00Z");
  assert.equal(mayCreateProjects(store.getAssistant(lead.id)), false);
});

test("ten creations within 24 hours reach the limit; older ones do not count", () => {
  const now = Date.parse("2026-10-28T12:00:00Z"),
    hour = 3600000;
  projectCreateLimit(
    Array.from({ length: 9 }, (_, i) => now - i * hour),
    now,
  );
  projectCreateLimit([...Array.from({ length: 9 }, () => now), now - 24 * hour], now);
  assert.throws(
    () =>
      projectCreateLimit(
        Array.from({ length: 10 }, () => now - hour),
        now,
      ),
    (e) =>
      e.key === "projectCreateLimit" &&
      e.status === 429 &&
      e.message.includes(String(projectCreateCaps.perDay)),
  );
});

test("the limit copy names the cap in both languages", () => {
  for (const lang of ["de", "en"]) {
    const copy = serverCatalogs[lang].agentProjects.projectCreateLimit;
    assert.equal(typeof copy, "function", lang);
    assert.match(copy(projectCreateCaps.perDay), /\b10\b/, lang);
    assert.match(copy(3), /\b3\b/, lang);
  }
});
