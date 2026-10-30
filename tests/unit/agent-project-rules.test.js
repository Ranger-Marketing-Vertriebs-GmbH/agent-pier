import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { validDirectoryName } from "../../server/lib/directories.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectName } from "../../server/features/assistants/agent-project-rules.js";
import { mayCreateProjects } from "../../server/features/assistants/goal-turns.js";
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

test("names with invisible format, separator or slash look-alike characters are refused", () => {
  for (const bad of [
    "a\u200bb", // zero-width space (Cf)
    "\u202e", // right-to-left override (Cf)
    "shop\u202egpj.exe",
    "a\u2066b", // isolate (Cf)
    "a\ufeffb", // byte order mark (Cf)
    "a\u2028b", // line separator (Zl)
    "a\u2029b", // paragraph separator (Zp)
    "a\u2215b", // division slash
    "a\u2044b", // fraction slash
    "a\uff0fb", // fullwidth solidus
    "a\u29f8b", // big solidus
    "..\uff0fx",
  ])
    assert.throws(
      () => projectName(bad),
      (e) => e.key === "projectNameInvalid" && e.status === 400,
      JSON.stringify(bad),
    );
  assert.equal(projectName("Café 2 ½"), "Café 2 ½");
});

const disguising = /[\p{Cf}\p{Zl}\p{Zp}\u2215\u2044\uff0f\u29f8]/u;
test("every name createDirectory accepts without a leading dot or disguise is a project name", () =>
  fc.assert(
    fc.property(fc.string({ maxLength: 300, unit: "grapheme" }), (name) =>
      validDirectoryName(name) && !name.startsWith(".") && !disguising.test(name)
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
