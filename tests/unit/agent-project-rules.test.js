import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { validDirectoryName } from "../../server/lib/directories.js";
import {
  projectCreateLimit,
  projectName,
} from "../../server/features/assistants/agent-project-rules.js";
import { mayCreateProjects } from "../../server/features/assistants/goal-turns.js";

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
    (e) => e.key === "projectCreateLimit" && e.status === 429,
  );
});
